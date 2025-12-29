using Avalonia.Controls;

namespace YtLiveTranslator.Desktop;

public partial class MainWindow : Window
{
    private bool _isRunning;

    public MainWindow()
    {
        InitializeComponent();
        UpdateUi();
    }

    private void StartButton_OnClick(object? sender, Avalonia.Interactivity.RoutedEventArgs e)
    {
        _isRunning = true;
        UpdateUi();
    }

    private void StopButton_OnClick(object? sender, Avalonia.Interactivity.RoutedEventArgs e)
    {
        _isRunning = false;
        UpdateUi();
    }

    private void UpdateUi()
    {
        StatusText.Text = _isRunning ? "Status: Running" : "Status: Idle";
        StartButton.IsEnabled = !_isRunning;
        StopButton.IsEnabled = _isRunning;
    }
}
