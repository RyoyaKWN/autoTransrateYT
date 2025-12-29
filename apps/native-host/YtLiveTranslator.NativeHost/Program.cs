using System;
using System.IO;
using System.Text;
using System.Text.Json;

class Program
{
    static readonly string LogPath = Path.Combine(Path.GetTempPath(), "nativehost.log");

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

                Log("Received: " + message);

                WriteMessage(output, new { ok = true, echo = message, at = DateTimeOffset.Now.ToString("o") });
                Log("Reply sent.");
            }
        }
        catch (Exception ex)
        {
            Log("EXCEPTION: " + ex);
            // ここでthrowすると Chrome側ではただ「exit」になるので、まずは落とさずログを残す
        }

        Log("NativeHost exiting.");
    }
}
