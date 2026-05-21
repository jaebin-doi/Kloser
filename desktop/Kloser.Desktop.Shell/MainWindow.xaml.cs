// Phase 9 Step 4 — main window code-behind.
//
// Construct the view model with a UiDispatcher bound to this window's
// Dispatcher so background-thread events (status pump, capture errors)
// marshal back to the UI thread. Dispose the view model on close so
// the capture controller releases NAudio handles + diagnostic writer.
//
// Phase 9 Step 6 (post-E2E diagnostic) — 창을 그냥 닫을 때도 archive를
// 안전하게 마무리시키려고 Closing에서 ShutdownAsync를 await한다. 첫 E2E
// 에서 End Call을 누르지 않고 X를 누르자 archive가 통째로 사라진 게 의심
// 원인 중 하나였다.

using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using Kloser.Desktop.Shell.Services;
using Kloser.Desktop.Shell.ViewModels;

namespace Kloser.Desktop.Shell;

public partial class MainWindow : Window
{
    private readonly MainWindowViewModel _viewModel;
    private bool _shutdownComplete;

    public MainWindow()
    {
        InitializeComponent();
        _viewModel = new MainWindowViewModel(new UiDispatcher(Dispatcher));
        DataContext = _viewModel;
        // Phase 9 Step 7 — VM이 LoginPassword를 비울 때 (login 성공 후) PasswordBox
        // 내부 SecureString도 함께 초기화해 평문 잔존을 막는다.
        _viewModel.PropertyChanged += (_, ev) =>
        {
            if (ev.PropertyName == nameof(MainWindowViewModel.LoginPassword)
                && string.IsNullOrEmpty(_viewModel.LoginPassword)
                && LoginPasswordBox.Password.Length > 0)
            {
                LoginPasswordBox.Clear();
            }
        };
        Closing += OnClosing;
        Closed += OnClosed;
    }

    // Phase 9 Step 7 — PasswordBox는 SecurityCritical Password property라 직접
    // databinding을 막아 둔다. 이 핸들러가 사용자 keystroke마다 VM에 평문을 한
    // 번씩 옮긴다. login 성공 후 VM이 LoginPassword=""로 비우면 PasswordBox는
    // 그대로 둬도 메모리상 평문이 사라진다 (사용자는 UI에서도 비워주는 게 명확).
    private void OnLoginPasswordChanged(object sender, RoutedEventArgs e)
    {
        if (sender is PasswordBox box)
        {
            _viewModel.LoginPassword = box.Password;
        }
    }

    private async void OnClosing(object? sender, CancelEventArgs e)
    {
        if (_shutdownComplete) return;
        // 통화/archive가 진행 중이 아니면 즉시 닫는다.
        if (!_viewModel.RequiresShutdownWait) return;

        // 첫 호출에서는 close를 취소하고, 비동기로 EndCallAsync + archive
        // upload 완료를 기다린 뒤 다시 Close()를 호출해 두 번째 호출에서
        // 정상 종료한다.
        e.Cancel = true;
        try { await _viewModel.ShutdownAsync(); }
        catch { /* swallow — shutdown best-effort */ }
        _shutdownComplete = true;
        Close();
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        try { _viewModel.StopCapture(); } catch { /* swallow */ }
        try { _viewModel.Dispose(); } catch { /* swallow */ }
    }
}
