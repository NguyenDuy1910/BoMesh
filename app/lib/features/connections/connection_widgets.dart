import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/app_theme.dart';
import 'connection_models.dart';

class IntegrationCard extends StatelessWidget {
  const IntegrationCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(20),
  });
  final Widget child;
  final EdgeInsetsGeometry padding;
  @override
  Widget build(BuildContext context) => Material(
    color: context.colors.surface,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(20),
      side: BorderSide(color: context.colors.border),
    ),
    clipBehavior: Clip.antiAlias,
    child: Padding(padding: padding, child: child),
  );
}

class IntegrationBody extends StatelessWidget {
  const IntegrationBody({super.key, required this.children, this.onRefresh});
  final List<Widget> children;
  final Future<void> Function()? onRefresh;
  @override
  Widget build(BuildContext context) {
    final scroll = ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
      children: [
        Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 880),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: children,
            ),
          ),
        ),
      ],
    );
    return SafeArea(
      top: false,
      child: onRefresh == null
          ? scroll
          : RefreshIndicator(onRefresh: onRefresh!, child: scroll),
    );
  }
}

class IntegrationNotice extends StatelessWidget {
  const IntegrationNotice({
    super.key,
    required this.message,
    this.onRetry,
    this.error = false,
  });
  final String message;
  final VoidCallback? onRetry;
  final bool error;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: error ? context.colors.dangerSoft : context.colors.brandSoft,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                error ? Icons.error_outline : Icons.info_outline,
                color: error ? context.colors.danger : context.colors.brand,
              ),
              const SizedBox(width: 12),
              Expanded(child: Text(message)),
            ],
          ),
          if (onRetry != null)
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh),
                label: const Text('Try again'),
              ),
            ),
        ],
      ),
    ),
  );
}

class StatusBadge extends StatelessWidget {
  const StatusBadge(this.status, {super.key});
  final String status;
  @override
  Widget build(BuildContext context) {
    final bad = const {
      'failed',
      'error',
      'expired',
      'reauth_required',
      'revoked',
      'connection_required',
      'timed_out',
    }.contains(status);
    final good = const {'ready', 'connected', 'completed'}.contains(status);
    final active = const {'running', 'pending'}.contains(status);
    final color = bad
        ? context.colors.danger
        : good || active
        ? context.colors.brand
        : context.colors.textSecondary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: bad
            ? context.colors.dangerSoft
            : good || active
            ? context.colors.brandSoft
            : context.colors.subtle,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            bad
                ? Icons.error_outline
                : good
                ? Icons.check_circle_outline
                : active
                ? Icons.sync
                : Icons.pause_circle_outline,
            size: 16,
            color: color,
          ),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              readable(status),
              style: TextStyle(
                color: color,
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class IntegrationEmpty extends StatelessWidget {
  const IntegrationEmpty({
    super.key,
    required this.title,
    required this.message,
    this.icon = Icons.hub_outlined,
  });
  final String title, message;
  final IconData icon;
  @override
  Widget build(BuildContext context) => IntegrationCard(
    child: Column(
      children: [
        Icon(icon, size: 40, color: context.colors.brand),
        const SizedBox(height: 16),
        Text(
          title,
          style: Theme.of(context).textTheme.titleLarge,
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 8),
        Text(
          message,
          style: TextStyle(color: context.colors.textSecondary),
          textAlign: TextAlign.center,
        ),
      ],
    ),
  );
}

class IntegrationPager extends StatelessWidget {
  const IntegrationPager({
    super.key,
    required this.page,
    required this.total,
    required this.pageSize,
    required this.busy,
    required this.onPage,
  });
  final int page, total, pageSize;
  final bool busy;
  final ValueChanged<int> onPage;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 16),
    child: Wrap(
      alignment: WrapAlignment.center,
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: 12,
      children: [
        IconButton(
          tooltip: 'Previous page',
          onPressed: busy || page <= 1 ? null : () => onPage(page - 1),
          icon: const Icon(Icons.chevron_left),
        ),
        Text('Page $page · $total total'),
        IconButton(
          tooltip: 'Next page',
          onPressed: busy || page * pageSize >= total
              ? null
              : () => onPage(page + 1),
          icon: const Icon(Icons.chevron_right),
        ),
      ],
    ),
  );
}

class DetailLine extends StatelessWidget {
  const DetailLine(this.label, this.value, {super.key});
  final String label, value;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 3),
        SelectableText(value.isEmpty ? 'Not available' : value),
      ],
    ),
  );
}

Future<bool> confirmIntegration(
  BuildContext context, {
  required String title,
  required String message,
  required String action,
}) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: SingleChildScrollView(child: Text(message)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep it'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(action),
          ),
        ],
      ),
    ) ??
    false;

void integrationToast(BuildContext context, String message) =>
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));

// One timer per mounted screen. No overlap, no background polling, and no
// refreshing a covered route. A manual refresh remains available after errors.
mixin IntegrationPolling<T extends StatefulWidget> on State<T>
    implements WidgetsBindingObserver {
  Timer? _pollTimer;
  bool _foreground = true;
  bool _polling = false;
  bool get pollingEnabled => true;
  Duration get pollingInterval => const Duration(seconds: 15);
  Future<void> poll();

  void startPolling() {
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    schedulePoll();
  }

  void schedulePoll() {
    _pollTimer?.cancel();
    if (!mounted || !_foreground || !pollingEnabled) return;
    _pollTimer = Timer(pollingInterval, _tick);
  }

  Future<void> _tick() async {
    if (!mounted || !_foreground || !pollingEnabled) return;
    if (!_polling && (ModalRoute.of(context)?.isCurrent ?? true)) {
      _polling = true;
      try {
        await poll();
      } finally {
        _polling = false;
      }
    }
    schedulePoll();
  }

  void stopPolling() {
    _pollTimer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _pollTimer?.cancel();
    if (_foreground) unawaited(_tick());
  }
}
