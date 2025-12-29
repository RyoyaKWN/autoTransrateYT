using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;

class Program
{
    static readonly string LogPath = Path.Combine(Path.GetTempPath(), "nativehost.log");
    static readonly object AudioLock = new();
    static MemoryStream? AudioBuffer;
    static bool IsAudioActive;
    static int AudioSampleRate = 16000;
    static readonly Queue<byte[]> AudioQueue = new();
    static bool IsWorkerRunning;
    static int AudioChunkCount;

    const int ChunkSeconds = 5;

    static void Log(string message)
    {
        // ログ書き込み自体がブロックされても、ここで落ちないようにする
        try
        {
            File.AppendAllText(LogPath, $"[{DateTime.Now:O}] {message}{Environment.NewLine}");
        }
        catch { /* ignore */ }

        // Chrome拡張の「エラー」に出る可能性があるので stderr にも出す
        try
        {
            Console.Error.WriteLine(message);
        }
        catch { /* ignore */ }
    }

    static int ReadMessageLength(Stream input)
    {
        Span<byte> lengthBytes = stackalloc byte[4];
        int read = input.Read(lengthBytes);
        if (read == 0) return 0;
        if (read < 4) throw new EndOfStreamException("Incomplete message length");
        return BitConverter.ToInt32(lengthBytes);
    }

    static string ReadMessage(Stream input)
    {
        int length = ReadMessageLength(input);
        if (length == 0) return "";
        byte[] buffer = new byte[length];
        int offset = 0;
        while (offset < length)
        {
            int read = input.Read(buffer, offset, length - offset);
            if (read <= 0) throw new EndOfStreamException("Incomplete message body");
            offset += read;
        }
        return Encoding.UTF8.GetString(buffer);
    }

    static void WriteMessage(Stream output, object obj)
    {
        string json = JsonSerializer.Serialize(obj);
        byte[] jsonBytes = Encoding.UTF8.GetBytes(json);
        byte[] lengthBytes = BitConverter.GetBytes(jsonBytes.Length);
        output.Write(lengthBytes, 0, lengthBytes.Length);
        output.Write(jsonBytes, 0, jsonBytes.Length);
        output.Flush();
    }

    static void Main()
    {
        Log("NativeHost started. LogPath=" + LogPath);

        try
        {
            using var input = Console.OpenStandardInput();
            using var output = Console.OpenStandardOutput();

            while (true)
            {
                string message = ReadMessage(input);

                if (message == "")
                {
                    Log("EOF received (length=0). Exiting loop.");
                    break;
                }

                var hasType = TryReadMessageType(message, out var type);
                if (hasType && type == "audio-chunk")
                {
                    HandleAudioChunk(message, output);
                    continue;
                }

                Log("Received: " + TruncateForLog(message, 400));

                if (hasType && type == "ping")
                {
                    WriteMessage(output, new { type = "pong", at = DateTimeOffset.Now.ToString("o") });
                    Log("Reply sent: pong.");
                }
                else if (hasType && type == "audio-start")
                {
                    StartAudioSession();
                    Log("Audio session started.");
                }
                else if (hasType && type == "audio-stop")
                {
                    StopAudioSession(output);
                    Log("Audio session stopped.");
                }
                else
                {
                    WriteMessage(output, new { ok = true, echo = message, at = DateTimeOffset.Now.ToString("o") });
                    Log("Reply sent: echo.");
                }
            }
        }
        catch (Exception ex)
        {
            Log("EXCEPTION: " + ex);
            // ここでthrowすると Chrome側ではただ「exit」になるので、まずは落とさずログを残す
        }

        Log("NativeHost exiting.");
    }

    static string TruncateForLog(string value, int maxLength)
    {
        if (value.Length <= maxLength) return value;
        return value.Substring(0, maxLength) + "...(truncated)";
    }

    static void StartAudioSession()
    {
        lock (AudioLock)
        {
            AudioBuffer?.Dispose();
            AudioBuffer = new MemoryStream();
            IsAudioActive = true;
            AudioQueue.Clear();
            AudioChunkCount = 0;
        }
    }

    static void StopAudioSession(Stream output)
    {
        lock (AudioLock)
        {
            IsAudioActive = false;
            if (AudioBuffer is { Length: > 0 })
            {
                var remaining = AudioBuffer.ToArray();
                AudioQueue.Enqueue(remaining);
                AudioBuffer.SetLength(0);
            }
        }
        StartWorkerIfNeeded(output);
    }

    static void HandleAudioChunk(string json, Stream output)
    {
        if (!TryReadAudioChunk(json, out var sampleRate, out var pcmBytes))
        {
            Log("audio-chunk parse failed");
            return;
        }

        lock (AudioLock)
        {
            if (!IsAudioActive)
            {
                return;
            }

            AudioSampleRate = sampleRate;
            AudioBuffer ??= new MemoryStream();
            AudioBuffer.Write(pcmBytes, 0, pcmBytes.Length);
            AudioChunkCount++;
            if (AudioChunkCount % 50 == 0)
            {
                Log($"audio chunks received: {AudioChunkCount}, sampleRate={AudioSampleRate}, bufferBytes={AudioBuffer.Length}");
            }

            int chunkBytes = sampleRate * ChunkSeconds * 2;
            if (AudioBuffer.Length >= chunkBytes)
            {
                var chunk = AudioBuffer.ToArray();
                AudioQueue.Enqueue(chunk);
                AudioBuffer.SetLength(0);
            }
        }

        StartWorkerIfNeeded(output);
    }

    static void StartWorkerIfNeeded(Stream output)
    {
        lock (AudioLock)
        {
            if (IsWorkerRunning || AudioQueue.Count == 0) return;
            IsWorkerRunning = true;
        }

        _ = Task.Run(() =>
        {
            try
            {
                while (true)
                {
                    byte[]? chunk;
                    lock (AudioLock)
                    {
                        if (AudioQueue.Count == 0)
                        {
                            IsWorkerRunning = false;
                            break;
                        }
                        chunk = AudioQueue.Dequeue();
                    }

                    if (chunk is null || chunk.Length == 0) continue;
                    var text = RunWhisper(chunk, AudioSampleRate);
                    if (!string.IsNullOrWhiteSpace(text))
                    {
                        WriteMessage(output, new { type = "asr-final", text });
                        Log("ASR text sent.");
                    }
                }
            }
            catch (Exception ex)
            {
                Log("ASR worker exception: " + ex);
            }
        });
    }

    static string RunWhisper(byte[] pcm16, int sampleRate)
    {
        string? exePath = Environment.GetEnvironmentVariable("WHISPER_EXE");
        string? modelPath = Environment.GetEnvironmentVariable("WHISPER_MODEL");
        if (string.IsNullOrWhiteSpace(exePath) || string.IsNullOrWhiteSpace(modelPath))
        {
            Log("WHISPER_EXE or WHISPER_MODEL not set.");
            return string.Empty;
        }

        string tempDir = Path.Combine(Path.GetTempPath(), "yt-live-translator");
        Directory.CreateDirectory(tempDir);
        string wavPath = Path.Combine(tempDir, $"audio_{Guid.NewGuid():N}.wav");
        string outBase = Path.Combine(tempDir, $"asr_{Guid.NewGuid():N}");
        string txtPath = outBase + ".txt";

        try
        {
            WriteWavPcm16(wavPath, pcm16, sampleRate, 1);
            var args = $"-m \"{modelPath}\" -f \"{wavPath}\" -l en -otxt -of \"{outBase}\"";
            Log("Whisper cmd: " + exePath + " " + args);
            var startInfo = new ProcessStartInfo
            {
                FileName = exePath,
                Arguments = args,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using var process = Process.Start(startInfo);
            if (process == null)
            {
                Log("Failed to start whisper process.");
                return string.Empty;
            }
            if (!process.WaitForExit(60000))
            {
                try { process.Kill(); } catch { }
                Log("Whisper timed out.");
                return string.Empty;
            }

            string stdout = process.StandardOutput.ReadToEnd();
            string stderr = process.StandardError.ReadToEnd();
            if (!string.IsNullOrWhiteSpace(stdout))
            {
                Log("Whisper stdout: " + TruncateForLog(stdout, 400));
            }
            if (!string.IsNullOrWhiteSpace(stderr))
            {
                Log("Whisper stderr: " + TruncateForLog(stderr, 400));
            }
            if (process.ExitCode != 0)
            {
                Log("Whisper exit code: " + process.ExitCode);
            }

            if (!File.Exists(txtPath))
            {
                Log("Whisper output not found.");
                return string.Empty;
            }
            return File.ReadAllText(txtPath).Trim();
        }
        catch (Exception ex)
        {
            Log("Whisper run failed: " + ex.Message);
            return string.Empty;
        }
        finally
        {
            SafeDelete(wavPath);
        }
    }

    static void WriteWavPcm16(string path, byte[] pcm16, int sampleRate, short channels)
    {
        using var fs = File.Create(path);
        using var bw = new BinaryWriter(fs);
        int byteRate = sampleRate * channels * 2;
        short blockAlign = (short)(channels * 2);

        bw.Write(Encoding.ASCII.GetBytes("RIFF"));
        bw.Write(36 + pcm16.Length);
        bw.Write(Encoding.ASCII.GetBytes("WAVE"));
        bw.Write(Encoding.ASCII.GetBytes("fmt "));
        bw.Write(16);
        bw.Write((short)1);
        bw.Write(channels);
        bw.Write(sampleRate);
        bw.Write(byteRate);
        bw.Write(blockAlign);
        bw.Write((short)16);
        bw.Write(Encoding.ASCII.GetBytes("data"));
        bw.Write(pcm16.Length);
        bw.Write(pcm16);
    }

    static void SafeDelete(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch { }
    }

    static bool TryReadMessageType(string json, out string type)
    {
        type = string.Empty;
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return false;
            if (!doc.RootElement.TryGetProperty("type", out var typeElement)) return false;
            type = typeElement.GetString() ?? string.Empty;
            return type.Length > 0;
        }
        catch
        {
            return false;
        }
    }

    static bool TryReadAudioChunk(string json, out int sampleRate, out byte[] pcmBytes)
    {
        sampleRate = 16000;
        pcmBytes = Array.Empty<byte>();
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("sampleRate", out var rateElement)) return false;
            if (!doc.RootElement.TryGetProperty("pcmBase64", out var pcmElement)) return false;

            sampleRate = rateElement.GetInt32();
            var base64 = pcmElement.GetString();
            if (string.IsNullOrWhiteSpace(base64)) return false;
            pcmBytes = Convert.FromBase64String(base64);
            return true;
        }
        catch
        {
            return false;
        }
    }
}

