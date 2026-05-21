// Phase 9 Step 4 — main window code-behind.
//
// Construct the view model with a UiDispatcher bound to this window's
// Dispatcher so background-thread events (status pump, capture errors)
// marshal back to the UI thread. Dispose the view model on close so
// the capture controller releases NAudio handles + diagnostic writer.

using System.Windows;
using Kloser.Desktop.Shell.Services;
using Kloser.Desktop.Shell.ViewModels;

namespace Kloser.Desktop.Shell;

public partial class MainWindow : Window
{
    private readonly MainWindowViewModel _viewModel;

    public MainWindow()
    {
        InitializeComponent();
        _viewModel = new MainWindowViewModel(new UiDispatcher(Dispatcher));
        DataContext = _viewModel;
        Closed += OnClosed;
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        try { _viewModel.StopCapture(); } catch { /* swallow */ }
        try { _viewModel.Dispose(); } catch { /* swallow */ }
    }
}
