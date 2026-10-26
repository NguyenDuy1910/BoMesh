import 'package:flutter/material.dart';

import '../../../app/workspace_scope.dart';
import '../../../core/api_client.dart';
import '../../../ui/ui.dart';
import '../../knowledge/document_page.dart';
import 'ingestion_models.dart';

/// What one run did, and the one fix: outcome in three numbers, failures with
/// their plain reason, and Retry pinned to the bottom.
class RunPage extends StatefulWidget {
  const RunPage({super.key, required this.runId});
  final String runId;

  @override
  State<RunPage> createState() => _RunPageState();
}

class _RunPageState extends State<RunPage> with LivePolling<RunPage> {
  static const _pageSize = 50;

  late ApiClient _api;
  late RunNames _names;
  bool _started = false;

  IngestionRun? _run;
  String _title = '';
  List<JsonMap> _failed = const [];
  int _failedTotal = 0;
  int _failedPage = 1;
  bool _loadingMore = false;
  Object? _error;
  bool _retrying = false;
  bool _canRetry = false;
  final Map<String, bool> _processingPermissions = {};

  Future<bool> _mayRetry(IngestionRun run) async {
    if (run.active || run.retryable == 0) return false;
    if (!mounted) return false;
    if (WorkspaceScope.of(context).session.can('ingestion.run')) return true;
    final items = await readAllPages(_api, '$_path/items');
    final ids = {
      for (final item in items)
        if (['failed', 'cancelled', 'skipped'].contains(item['status']))
          textOf(item['collection_id']),
    };
    if (ids.isEmpty || ids.contains('')) return false;
    for (final id in ids) {
      if (!_processingPermissions.containsKey(id)) {
        try {
          final collection = await _api.get('/collections/${Uri.encodeComponent(id)}');
          _processingPermissions[id] = (collection['permissions'] as List?)?.contains('ingestion.run') ?? false;
        } catch (_) {
          return false;
        }
      }
      if (_processingPermissions[id] != true) return false;
    }
    return true;
  }

  String get _path => '/ingestion-runs/${Uri.encodeComponent(widget.runId)}';

  @override
  Duration get pollInterval => const Duration(seconds: 3);

  @override
  bool get hasLiveWork => _run?.active ?? false;

  @override
  void didChangeDependencies() {
    final scope = WorkspaceScope.of(context);
    if (!_started || !identical(scope.api, _api)) {
      _api = scope.api;
      _names = RunNames(_api);
      _started = true;
      _load();
    }
    super.didChangeDependencies();
  }

  Future<void> _load() async {
    try {
      final run = IngestionRun.fromJson(await _api.get(_path));
      final title = await _names.title(run);
      final failed = await _readFailed(1);
      final canRetry = await _mayRetry(run);
      if (!mounted) return;
      setState(() {
        _run = run;
        _canRetry = canRetry;
        _title = title;
        _failed = objectList(failed['items']);
        _failedTotal = intOf(failed['total']);
        _failedPage = 1;
        _error = null;
      });
    } catch (error) {
      if (mounted) setState(() => _error = error);
    }
    syncPolling();
  }

  Future<JsonMap> _readFailed(int page) => _api.get(
    '$_path/items',
    query: {'status': 'failed', 'page': page, 'page_size': _pageSize},
  );

  @override
  Future<void> poll() async {
    final previous = _run;
    final run = IngestionRun.fromJson(await _api.get(_path));
    final failedChanged =
        previous == null ||
        previous.failed != run.failed ||
        previous.active != run.active;
    final failed = failedChanged ? await _readFailed(1) : null;
    final canRetry = failedChanged ? await _mayRetry(run) : _canRetry;
    if (!mounted) return;
    setState(() {
      _run = run;
      _canRetry = canRetry;
      if (failed != null) {
        _failed = objectList(failed['items']);
        _failedTotal = intOf(failed['total']);
        _failedPage = 1;
      }
    });
  }

  Future<void> _showMoreFailed() async {
    setState(() => _loadingMore = true);
    try {
      final page = await _readFailed(_failedPage + 1);
      if (!mounted) return;
      setState(() {
        _failed = [..._failed, ...objectList(page['items'])];
        _failedTotal = intOf(page['total']);
        _failedPage++;
      });
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  Future<void> _retry() async {
    setState(() => _retrying = true);
    try {
      final next = IngestionRun.fromJson(await _api.post('$_path/retry'));
      if (!mounted) return;
      await Navigator.of(context).pushReplacement(
        MaterialPageRoute<void>(builder: (_) => RunPage(runId: next.id)),
      );
    } catch (error) {
      if (mounted) {
        setState(() => _retrying = false);
        showError(context, error);
      }
    }
  }

  Future<void> _cancel() async {
    final confirmed = await confirmAction(
      context,
      title: 'Cancel this run?',
      message: 'Documents already searchable stay searchable. The rest wait for another run.',
      confirmLabel: 'Cancel run',
      destructive: true,
    );
    if (!confirmed || !mounted) return;
    try {
      final run = IngestionRun.fromJson(await _api.post('$_path/cancel'));
      if (!mounted) return;
      setState(() => _run = run);
      showToast(context, 'Run cancelled');
      await _load();
    } catch (error) {
      if (mounted) showError(context, error);
    }
  }

  void _openMore(IngestionRun run) {
    final scope = WorkspaceScope.of(context);
    final canCancel =
        run.active &&
        (run.startedBy(scope.session.userId) ||
            scope.session.can('ingestion.manage'));
    final started = run.startedAt ?? run.createdAt;
    showAppSheet<void>(
      context,
      builder: (sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SheetOption(
            icon: Icons.person_outline_rounded,
            title: 'Started by ${run.starter(scope.session.userId)}',
            subtitle: started == null ? null : exactTime(started),
          ),
          if (canCancel)
            SheetOption(
              icon: Icons.close_rounded,
              title: 'Cancel run',
              subtitle: 'Stop before the remaining documents',
              danger: true,
              onTap: () {
                Navigator.pop(sheetContext);
                _cancel();
              },
            ),
        ],
      ),
    );
  }

  String _subtitle(IngestionRun run) {
    final started = run.startedAt ?? run.createdAt;
    return switch (run.status) {
      'running' => 'Running · started ${relativeTime(started)}',
      'queued' => 'Waiting to start · added ${relativeTime(run.createdAt)}',
      'cancelled' => 'Cancelled ${_moment(run.finishedAt)}',
      'failed' => 'Stopped ${_moment(run.finishedAt)}',
      _ => 'Finished ${_moment(run.finishedAt)}',
    };
  }

  /// "16:20", "yesterday 16:20", or "16:20, 3 Oct".
  String _moment(DateTime? time) {
    if (time == null) return '';
    final now = DateTime.now();
    final days = DateTime(
      now.year,
      now.month,
      now.day,
    ).difference(DateTime(time.year, time.month, time.day)).inDays;
    final clock = '${time.hour}:${time.minute.toString().padLeft(2, '0')}';
    if (days == 0) return clock;
    if (days == 1) return 'yesterday $clock';
    return exactTime(time);
  }

  @override
  Widget build(BuildContext context) {
    final run = _run;
    return Scaffold(
      appBar: AppHeader(
        title: run == null ? null : _title,
        subtitle: run == null ? null : _subtitle(run),
        rule: true,
        actions: [
          if (run != null)
            IconButton(
              tooltip: 'More',
              onPressed: () => _openMore(run),
              icon: const Icon(Icons.more_horiz_rounded),
            ),
        ],
      ),
      body: run == null
          ? (_error != null
                ? ErrorView(error: _error!, onRetry: _load)
                : const LoadingView())
          : RefreshIndicator(onRefresh: _load, child: _body(run)),
      bottomNavigationBar: run == null || run.active || run.retryable == 0 || !_canRetry
          ? null
          : StickyActionBar(
              note: run.succeeded > 0
                  ? 'Retrying keeps the ${groupedNumber(run.succeeded)} that worked.'
                  : null,
              children: [
                FilledButton.icon(
                  onPressed: _retrying ? null : _retry,
                  icon: _retrying
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.refresh_rounded, size: 18),
                  label: Text(
                    run.retryable == run.failed
                        ? 'Retry ${groupedNumber(run.failed)} failed'
                        : 'Retry ${countOf(run.retryable, 'document')}',
                  ),
                ),
              ],
            ),
    );
  }

  Widget _body(IngestionRun run) {
    final colors = context.colors;
    final notDone = run.skipped + run.cancelled;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: kPagePadding,
      children: [
        const SizedBox(height: 10),
        _OutcomeBar(run: run),
        if (run.active) ...[
          const SizedBox(height: 6),
          Text(
            '${groupedNumber(run.done)} of ${groupedNumber(run.total)}',
            style: TextStyle(color: colors.ink3, fontSize: 12),
          ),
        ],
        const SizedBox(height: 14),
        Row(
          children: [
            Expanded(
              child: _StatTile(label: 'Searchable', value: run.succeeded),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _StatTile(label: 'Failed', value: run.failed, bad: true),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _StatTile(label: 'Skipped', value: notDone),
            ),
          ],
        ),
        if (run.status == 'failed') ...[
          const SizedBox(height: 14),
          InlineNotice(
            text: plainReason(
              run.error,
              fallback: 'Processing stopped before it finished.',
            ),
            icon: Icons.warning_amber_rounded,
            tone: StatusTone.danger,
          ),
        ],
        if (!run.active && run.total == 0) ...[
          const SizedBox(height: 14),
          const InlineNotice(text: 'Nothing in this run needed processing.'),
        ],
        if (!run.active && run.failed > 0 && _failed.isEmpty) ...[
          const SizedBox(height: 14),
          const InlineNotice(
            text: 'The documents that failed are no longer in a collection you can open.',
          ),
        ],
        if (_failed.isNotEmpty) ...[
          SectionLabel('Failed', aside: groupedNumber(_failedTotal)),
          ListGroup(
            children: [
              for (final item in _failed)
                ListRow(
                  leading: FileTile(name: textOf(item['name'])),
                  title: textOf(item['name'], 'Untitled document'),
                  subtitleWidget: Text(
                    plainReason(textOf(item['error'])),
                    style: TextStyle(color: colors.danger),
                  ),
                  maxSubtitleLines: 2,
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) =>
                          DocumentPage(documentId: textOf(item['document_id'])),
                    ),
                  ),
                ),
            ],
          ),
          if (_failed.length < _failedTotal)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: TextButton(
                onPressed: _loadingMore ? null : _showMoreFailed,
                child: Text(_loadingMore ? 'Loading…' : 'Show more'),
              ),
            ),
        ],
      ],
    );
  }
}

/// The run's outcome in one bar: searchable in violet, failed in red.
class _OutcomeBar extends StatelessWidget {
  const _OutcomeBar({required this.run});
  final IngestionRun run;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final total = run.total;
    return ClipRRect(
      borderRadius: BorderRadius.circular(999),
      child: SizedBox(
        height: 8,
        child: ColoredBox(
          color: colors.subtle,
          child: total == 0
              ? const SizedBox.expand()
              : Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (run.succeeded > 0)
                      Expanded(
                        flex: run.succeeded,
                        child: ColoredBox(color: colors.brand),
                      ),
                    if (run.failed > 0)
                      Expanded(
                        flex: run.failed,
                        child: ColoredBox(color: colors.danger),
                      ),
                    if (total - run.succeeded - run.failed > 0)
                      Spacer(flex: total - run.succeeded - run.failed),
                  ],
                ),
        ),
      ),
    );
  }
}

class _StatTile extends StatelessWidget {
  const _StatTile({required this.label, required this.value, this.bad = false});
  final String label;
  final int value;
  final bool bad;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: colors.subtle,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(color: colors.ink3, fontSize: 12)),
          const SizedBox(height: 2),
          Text(
            groupedNumber(value),
            style: TextStyle(
              color: bad && value > 0 ? colors.danger : colors.ink,
              fontSize: 20,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}
