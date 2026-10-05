import 'package:flutter/material.dart';

import '../../../app/workspace_scope.dart';
import '../../../core/api_client.dart';
import '../../../ui/ui.dart';
import 'ingestion_models.dart';
import 'new_run_sheet.dart';
import 'run_page.dart';
import 'source_sheet.dart';

/// Manage → Ingestion: runs readable at a glance, and the connected sources.
/// The tab decides the one action — New run on Runs, Sync now per source.
class IngestionPage extends StatefulWidget {
  const IngestionPage({super.key});

  @override
  State<IngestionPage> createState() => _IngestionPageState();
}

class _IngestionPageState extends State<IngestionPage>
    with SingleTickerProviderStateMixin {
  TabController? _tabs;
  ApiClient? _api;
  late RunNames _names;
  final _runsKey = GlobalKey<_RunsTabState>();

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final scope = WorkspaceScope.of(context);
    if (!identical(scope.api, _api)) {
      _api = scope.api;
      _names = RunNames(scope.api);
    }
    final length = scope.session.can('source.manage') ? 2 : 1;
    if (_tabs?.length != length) {
      _tabs?.dispose();
      _tabs = TabController(length: length, vsync: this)
        ..addListener(() {
          if (mounted) setState(() {});
        });
    }
  }

  @override
  void dispose() {
    _tabs?.dispose();
    super.dispose();
  }

  Future<void> _newRun() async {
    final scope = WorkspaceScope.of(context);
    final runId = await showNewRunSheet(
      context,
      api: scope.api,
      session: scope.session,
      names: _names,
    );
    if (runId == null || runId.isEmpty || !mounted) return;
    _runsKey.currentState?.reload();
    await Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => RunPage(runId: runId)));
    _runsKey.currentState?.reload();
  }

  @override
  Widget build(BuildContext context) {
    final scope = WorkspaceScope.of(context);
    final tabs = _tabs!;
    final withSources = tabs.length == 2;
    final onRuns = tabs.index == 0;
    final runs = _RunsTab(
      key: _runsKey,
      api: scope.api,
      names: _names,
      userId: scope.session.userId,
      onNewRun: scope.session.can('ingestion.run') ? _newRun : null,
    );
    return Scaffold(
      backgroundColor: context.colors.paper,
      appBar: AppHeader(
        title: 'Ingestion',
        paper: true,
        bottom: withSources
            ? AppTabBar(controller: tabs, labels: const ['Runs', 'Sources'])
            : null,
      ),
      body: withSources
          ? TabBarView(
              controller: tabs,
              children: [
                runs,
                _SourcesTab(api: scope.api, names: _names),
              ],
            )
          : runs,
      floatingActionButton: onRuns && scope.session.can('ingestion.run')
          ? AppFab(
              icon: Icons.play_arrow_rounded,
              label: 'New run',
              onPressed: _newRun,
            )
          : null,
    );
  }
}

// ---------------------------------------------------------------------------
// Runs

class _RunsTab extends StatefulWidget {
  const _RunsTab({
    super.key,
    required this.api,
    required this.names,
    required this.userId,
    required this.onNewRun,
  });
  final ApiClient api;
  final RunNames names;
  final String userId;
  final VoidCallback? onNewRun;

  @override
  State<_RunsTab> createState() => _RunsTabState();
}

class _RunsTabState extends State<_RunsTab>
    with AutomaticKeepAliveClientMixin, LivePolling<_RunsTab> {
  List<IngestionRun>? _runs;
  Map<String, String> _titles = const {};
  Object? _error;

  @override
  bool get wantKeepAlive => true;

  @override
  Duration get pollInterval => const Duration(seconds: 4);

  @override
  bool get hasLiveWork => _runs?.any((run) => run.active) ?? false;

  @override
  void initState() {
    super.initState();
    reload();
  }

  @override
  void didUpdateWidget(covariant _RunsTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.api, widget.api)) {
      setState(() => _runs = null);
      reload();
    }
  }

  Future<void> reload() async {
    try {
      await poll();
      if (mounted && _error != null) setState(() => _error = null);
    } catch (error) {
      if (mounted) setState(() => _error = error);
    }
    syncPolling();
  }

  @override
  Future<void> poll() async {
    final page = await widget.api.get(
      '/ingestion-runs',
      query: {'page': 1, 'page_size': 30},
    );
    final runs = objectList(page['items']).map(IngestionRun.fromJson).toList();
    final titles = Map.fromIterables(
      runs.map((run) => run.id),
      await Future.wait(runs.map(widget.names.title)),
    );
    if (!mounted) return;
    setState(() {
      _runs = runs;
      _titles = titles;
    });
  }

  Future<void> _open(IngestionRun run) async {
    await Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => RunPage(runId: run.id)));
    reload();
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final runs = _runs;
    if (runs == null) {
      return _error != null
          ? ErrorView(error: _error!, onRetry: reload)
          : const LoadingView();
    }
    if (runs.isEmpty) {
      return RefreshIndicator(
        onRefresh: reload,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            EmptyView(
              icon: Icons.move_to_inbox_outlined,
              title: 'No runs yet',
              message: 'A run makes new and changed documents searchable in answers.',
              actionLabel: widget.onNewRun == null ? null : 'New run',
              onAction: widget.onNewRun,
            ),
          ],
        ),
      );
    }
    final active = runs.where((run) => run.active).toList();
    final recent = runs.where((run) => !run.active).toList();
    return RefreshIndicator(
      onRefresh: reload,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: kPagePadding.copyWith(bottom: kFabClearance),
        children: [
          if (active.isNotEmpty) ...[
            const SectionLabel('Running', first: true),
            for (final run in active) _card(run),
          ],
          if (recent.isNotEmpty) ...[
            SectionLabel('Recent', first: active.isEmpty),
            for (final run in recent) _card(run),
          ],
        ],
      ),
    );
  }

  Widget _card(IngestionRun run) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: _RunCard(
      run: run,
      title: _titles[run.id] ?? '',
      meta: run.active
          ? 'Started by ${run.starter(widget.userId)} · ${relativeTime(run.startedAt ?? run.createdAt)}'
          : '${groupedNumber(run.succeeded)} searchable · ${relativeTime(run.finishedAt ?? run.createdAt)}',
      onTap: () => _open(run),
    ),
  );
}

/// A run in one card: what, its status word, one line of outcome, and — while
/// it runs — its progress.
class _RunCard extends StatelessWidget {
  const _RunCard({
    required this.run,
    required this.title,
    required this.meta,
    required this.onTap,
  });
  final IngestionRun run;
  final String title, meta;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final progress = run.total == 0 ? 0.0 : run.done / run.total;
    return Material(
      color: colors.canvas,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: colors.line),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  run.tile(),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: colors.ink,
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  run.pill,
                ],
              ),
              const SizedBox(height: 4),
              Text(meta, style: TextStyle(color: colors.ink3, fontSize: 13)),
              if (run.active) ...[
                const SizedBox(height: 12),
                ClipRRect(
                  borderRadius: BorderRadius.circular(999),
                  child: LinearProgressIndicator(
                    value: progress.clamp(0.0, 1.0),
                    minHeight: 6,
                    color: colors.brand,
                    backgroundColor: colors.subtle,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  '${groupedNumber(run.done)} of ${groupedNumber(run.total)}',
                  style: TextStyle(color: colors.ink3, fontSize: 12),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Sources

class _SourcesTab extends StatefulWidget {
  const _SourcesTab({required this.api, required this.names});
  final ApiClient api;
  final RunNames names;

  @override
  State<_SourcesTab> createState() => _SourcesTabState();
}

class _SourcesTabState extends State<_SourcesTab>
    with AutomaticKeepAliveClientMixin {
  List<JsonMap>? _sources;
  Map<String, String> _collections = const {};
  final Set<String> _syncing = {};
  Object? _error;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant _SourcesTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.api, widget.api)) {
      setState(() => _sources = null);
      _load();
    }
  }

  Future<void> _load() async {
    try {
      final sources = await readAllPages(widget.api, '/sources');
      final ids = {
        for (final source in sources) textOf(source['collection_id']),
      }..remove('');
      final titles = Map.fromIterables(
        ids,
        await Future.wait(ids.map(widget.names.collection)),
      );
      if (!mounted) return;
      setState(() {
        _sources = sources;
        _collections = titles;
        _error = null;
      });
    } catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  String _collectionOf(JsonMap source) =>
      _collections[textOf(source['collection_id'])] ?? 'a collection';

  Future<void> _sync(JsonMap source) async {
    final id = textOf(source['id']);
    setState(() => _syncing.add(id));
    try {
      final updated = await widget.api.post(
        '/sources/${Uri.encodeComponent(id)}/syncs',
      );
      if (!mounted) return;
      setState(() {
        _sources = [
          for (final item in _sources ?? const <JsonMap>[])
            textOf(item['id']) == id && updated.isNotEmpty ? updated : item,
        ];
      });
      showToast(context, 'Sync started');
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _syncing.remove(id));
    }
  }

  Future<void> _open(JsonMap source) async {
    await showSourceSheet(
      context,
      api: widget.api,
      source: source,
      collectionTitle: _collectionOf(source),
      canSync: true,
    );
    if (mounted) _load();
  }

  String _meta(JsonMap source) {
    final sync = objectOf(source['sync']);
    final schedule = objectOf(source['schedule']);
    final parts = <String>['Into ${_collectionOf(source)}'];
    if (textOf(sync['status']) == 'running') {
      parts.add('syncing now');
    } else if (sync['last_synced_at'] != null) {
      parts.add('synced ${relativeTime(sync['last_synced_at'])}');
    } else {
      parts.add('not synced yet');
    }
    if (textOf(source['status']) == 'paused' ||
        (schedule.isNotEmpty && schedule['enabled'] != true)) {
      parts.add('paused');
    } else if (schedule.isNotEmpty) {
      parts.add(scheduleCadence(schedule));
    }
    return parts.join(' · ');
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final sources = _sources;
    if (sources == null) {
      return _error != null
          ? ErrorView(error: _error!, onRetry: _load)
          : const LoadingView();
    }
    const notice = InlineNotice(
      text: 'Connect new sources from BoMesh on the web.',
      icon: Icons.power_outlined,
    );
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: kPagePadding,
        children: [
          if (sources.isEmpty)
            const EmptyView(
              icon: Icons.power_outlined,
              title: 'No sources connected',
              message: 'Connect new sources from BoMesh on the web.',
            )
          else ...[
            SectionLabel(
              'Connected',
              aside: groupedNumber(sources.length),
              first: true,
            ),
            ListGroup(children: [for (final source in sources) _row(source)]),
            const SizedBox(height: 14),
            notice,
          ],
        ],
      ),
    );
  }

  Widget _row(JsonMap source) {
    final id = textOf(source['id']);
    final busy = _syncing.contains(id);
    final status = textOf(source['status']);
    final canSync =
        status != 'connection_required' &&
        status != 'disabled' &&
        textOf(objectOf(source['sync'])['status']) != 'running';
    return ListRow(
      leading: const ToneTile(
        tone: Tone.sky,
        icon: Icons.power_outlined,
        size: TileSize.small,
      ),
      title: sourceName(source),
      subtitle: _meta(source),
      onTap: () => _open(source),
      trailing: busy
          ? const Padding(
              padding: EdgeInsets.all(12),
              child: SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            )
          : IconButton(
              tooltip: 'Sync now',
              onPressed: canSync ? () => _sync(source) : null,
              icon: const Icon(Icons.refresh_rounded),
            ),
    );
  }
}
