import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/app_theme.dart';
import '../../core/api_client.dart';
import '../auth/session.dart';
import 'connection_models.dart';
import 'connection_widgets.dart';

class IngestionActivityPage extends StatefulWidget {
  const IngestionActivityPage({
    super.key,
    required this.api,
    required this.session,
  });
  final ApiClient api;
  final AuthSession session;
  @override
  State<IngestionActivityPage> createState() => _IngestionActivityPageState();
}

class _IngestionActivityPageState extends State<IngestionActivityPage>
    with WidgetsBindingObserver, IntegrationPolling<IngestionActivityPage> {
  List<IngestionRecord> _items = [];
  JsonMap? _summary;
  String? _error, _summaryError;
  String _status = '', _kind = '', _window = '24h';
  String? _collectionId, _sourceId, _connectionId;
  final _document = TextEditingController();
  bool _loading = false, _live = true;
  int _page = 1, _total = 0, _generation = 0;
  DateTime? _updatedAt;
  @override
  bool get pollingEnabled => _live;
  @override
  Duration get pollingInterval => _error != null
      ? const Duration(seconds: 15)
      : countOf(_summary?['active']) > 0 || _items.any((item) => item.active)
      ? const Duration(seconds: 2)
      : const Duration(seconds: 15);
  @override
  Future<void> poll() => _load(silent: true);
  @override
  void initState() {
    super.initState();
    unawaited(_load());
    startPolling();
  }

  @override
  void dispose() {
    _generation++;
    _document.dispose();
    stopPolling();
    super.dispose();
  }

  Future<void> _load({bool silent = false}) async {
    if (silent && _loading) return;
    final generation = ++_generation;
    final window = _window;
    if (!silent) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    final summaryRequest = widget.api
        .get('/ingestions/summary', query: {'window': window})
        .then<JsonMap?>(
          (value) => value,
          onError: (Object error) {
            if (mounted && generation == _generation) {
              setState(() => _summaryError = '$error');
            }
            return null;
          },
        );
    try {
      final result = await widget.api.get(
        '/ingestions',
        query: {
          'page': _page,
          'page_size': 20,
          if (_kind.isNotEmpty) 'kind': _kind,
          if (_status.isNotEmpty) 'status': _status,
          if (_collectionId != null) 'collection_id': _collectionId,
          if (_sourceId != null) 'source_id': _sourceId,
          if (_connectionId != null) 'connection_id': _connectionId,
          if (_document.text.trim().isNotEmpty)
            'document_id': _document.text.trim(),
        },
      );
      if (!mounted || generation != _generation) return;
      setState(() {
        _items = objectList(result['items']).map(IngestionRecord.new).toList();
        _total = countOf(result['total']);
        _error = null;
        _updatedAt = DateTime.now();
      });
    } catch (error) {
      if (mounted && generation == _generation) {
        setState(() => _error = '$error');
      }
    } finally {
      final summary = await summaryRequest;
      if (mounted && generation == _generation) {
        setState(() {
          _loading = false;
          if (summary != null) {
            _summary = summary;
            _summaryError = null;
          }
        });
        schedulePoll();
      }
    }
  }

  void _filterChanged() {
    _page = 1;
    unawaited(_load());
  }

  Future<void> _pickFilter(String resource) async {
    final result = await Navigator.push<JsonMap>(
      context,
      MaterialPageRoute(
        builder: (_) =>
            _ActivityResourcePicker(api: widget.api, resource: resource),
      ),
    );
    if (!mounted || result == null) return;
    setState(() {
      if (resource == 'collections') _collectionId = textOf(result['id']);
      if (resource == 'sources') _sourceId = textOf(result['id']);
      if (resource == 'connections') _connectionId = textOf(result['id']);
    });
    _filterChanged();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Sync activity'),
      actions: [
        IconButton(
          tooltip: _live ? 'Pause live updates' : 'Resume live updates',
          onPressed: () {
            setState(() => _live = !_live);
            schedulePoll();
            if (_live) unawaited(_load(silent: true));
          },
          icon: Icon(
            _live ? Icons.pause_circle_outline : Icons.play_circle_outline,
          ),
        ),
        IconButton(
          tooltip: 'Refresh activity',
          onPressed: _loading ? null : () => _load(),
          icon: const Icon(Icons.refresh),
        ),
      ],
    ),
    body: IntegrationBody(
      onRefresh: _load,
      children: [
        Text(
          'From source to searchable.',
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: 8),
        Text(
          'Workspace uploads and connected sources. Personal uploads are tracked with their documents.',
          style: TextStyle(color: context.colors.textSecondary),
        ),
        const SizedBox(height: 20),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final entry in const {
              '1h': 'Last hour',
              '24h': 'Last 24 hours',
              '7d': 'Last 7 days',
            }.entries)
              ChoiceChip(
                label: Text(entry.value),
                selected: _window == entry.key,
                onSelected: (_) {
                  setState(() => _window = entry.key);
                  unawaited(_load());
                },
              ),
          ],
        ),
        const SizedBox(height: 16),
        if (_summaryError != null)
          IntegrationNotice(
            message: 'Summary unavailable. $_summaryError',
            error: true,
            onRetry: () => _load(),
          ),
        if (_summary != null) _ActivitySummary(summary: _summary!),
        const SizedBox(height: 24),
        Text(
          'Ingestion history',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 12),
        LayoutBuilder(
          builder: (context, constraints) {
            final status = DropdownButtonFormField<String>(
              initialValue: _status,
              key: ValueKey('status:$_status'),
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Status'),
              items: [
                const DropdownMenuItem(value: '', child: Text('All statuses')),
                for (final status in const [
                  'pending',
                  'running',
                  'completed',
                  'failed',
                  'cancelled',
                  'timed_out',
                ])
                  DropdownMenuItem(
                    value: status,
                    child: Text(readable(status)),
                  ),
              ],
              onChanged: (value) {
                setState(() => _status = value!);
                _filterChanged();
              },
            );
            final kind = DropdownButtonFormField<String>(
              initialValue: _kind,
              key: ValueKey('kind:$_kind'),
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Kind'),
              items: const [
                DropdownMenuItem(value: '', child: Text('All ingestions')),
                DropdownMenuItem(value: 'document', child: Text('Documents')),
                DropdownMenuItem(
                  value: 'source',
                  child: Text('Connected sources'),
                ),
              ],
              onChanged: (value) {
                setState(() => _kind = value!);
                _filterChanged();
              },
            );
            return constraints.maxWidth < 500
                ? Column(children: [status, const SizedBox(height: 12), kind])
                : Row(
                    children: [
                      Expanded(child: status),
                      const SizedBox(width: 12),
                      Expanded(child: kind),
                    ],
                  );
          },
        ),
        const SizedBox(height: 12),
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          title: const Text('Filter by knowledge resource'),
          children: [
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                InputChip(
                  label: Text(
                    _collectionId == null
                        ? 'Collection'
                        : 'Collection selected',
                  ),
                  onPressed: () => _pickFilter('collections'),
                  onDeleted: _collectionId == null
                      ? null
                      : () {
                          setState(() => _collectionId = null);
                          _filterChanged();
                        },
                ),
                if (widget.session.can('source.manage')) ...[
                  InputChip(
                    label: Text(
                      _sourceId == null ? 'Source' : 'Source selected',
                    ),
                    onPressed: () => _pickFilter('sources'),
                    onDeleted: _sourceId == null
                        ? null
                        : () {
                            setState(() => _sourceId = null);
                            _filterChanged();
                          },
                  ),
                  InputChip(
                    label: Text(
                      _connectionId == null ? 'Account' : 'Account selected',
                    ),
                    onPressed: () => _pickFilter('connections'),
                    onDeleted: _connectionId == null
                        ? null
                        : () {
                            setState(() => _connectionId = null);
                            _filterChanged();
                          },
                  ),
                ],
              ],
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _document,
              decoration: const InputDecoration(
                labelText: 'Document ID (optional)',
              ),
              textInputAction: TextInputAction.search,
              onSubmitted: (_) => _filterChanged(),
            ),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                onPressed: _filterChanged,
                child: const Text('Apply document filter'),
              ),
            ),
          ],
        ),
        Text(
          '${_live ? 'Live updates' : 'Updates paused'}${_updatedAt == null ? '' : ' · Updated ${dateLabel(_updatedAt!.toIso8601String())}'}',
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: 16),
        if (_error != null)
          IntegrationNotice(
            message: _error!,
            error: true,
            onRetry: () => _load(),
          ),
        if (_loading)
          const Padding(
            padding: EdgeInsets.only(bottom: 16),
            child: LinearProgressIndicator(),
          ),
        if (!_loading && _items.isEmpty && _error == null)
          const IntegrationEmpty(
            title: 'No ingestions match',
            message: 'Try another filter, upload a document to a workspace collection, or sync a connected source.',
            icon: Icons.history,
          ),
        for (final item in _items)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: IngestionTile(
              ingestion: item,
              onTap: () async {
                await Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => IngestionDetailPage(
                      api: widget.api,
                      session: widget.session,
                      ingestionId: item.id,
                    ),
                  ),
                );
                if (mounted) await _load(silent: true);
              },
            ),
          ),
        IntegrationPager(
          page: _page,
          total: _total,
          pageSize: 20,
          busy: _loading,
          onPage: (page) {
            _page = page;
            unawaited(_load());
          },
        ),
      ],
    ),
  );
}

class IngestionTile extends StatelessWidget {
  const IngestionTile({
    super.key,
    required this.ingestion,
    required this.onTap,
  });
  final IngestionRecord ingestion;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => IntegrationCard(
    padding: EdgeInsets.zero,
    child: InkWell(
      borderRadius: BorderRadius.circular(20),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  ingestion.kind == 'source'
                      ? Icons.sync
                      : Icons.description_outlined,
                  color: context.colors.brand,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    ingestion.title,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                const Icon(Icons.chevron_right),
              ],
            ),
            const SizedBox(height: 12),
            StatusBadge(ingestion.status),
            const SizedBox(height: 8),
            Text(ingestion.progressLabel),
            if (ingestion.active)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: LinearProgressIndicator(value: ingestion.progressRatio),
              ),
            if (ingestion.error.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  ingestion.error,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: context.colors.danger),
                ),
              ),
            const SizedBox(height: 12),
            Text(
              '${readable(ingestion.trigger)} · ${dateLabel(ingestion.createdAt)} · ${durationLabel(ingestion.durationMs)}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ),
    ),
  );
}

class _ActivitySummary extends StatelessWidget {
  const _ActivitySummary({required this.summary});
  final JsonMap summary;
  @override
  Widget build(BuildContext context) {
    final totals = objectOf(summary['totals']);
    final kind = objectOf(summary['by_kind']);
    final durations = objectOf(summary['duration_ms']);
    final buckets = objectList(summary['buckets']);
    return IntegrationCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Workspace overview',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 16),
          LayoutBuilder(
            builder: (context, constraints) {
              final width = (constraints.maxWidth - 12) / 2;
              return Wrap(
                spacing: 12,
                runSpacing: 16,
                children: [
                  for (final metric in <String, int>{
                    'Active now': countOf(summary['active']),
                    'Completed': countOf(totals['completed']),
                    'Failed': countOf(totals['failed']),
                    'Timed out': countOf(totals['timed_out']),
                    'Cancelled': countOf(totals['cancelled']),
                    'Pending': countOf(totals['pending']),
                  }.entries)
                    SizedBox(
                      width: width,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '${metric.value}',
                            style: Theme.of(context).textTheme.headlineSmall,
                          ),
                          Text(
                            metric.key,
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                        ],
                      ),
                    ),
                ],
              );
            },
          ),
          const SizedBox(height: 20),
          Text(
            '${countOf(kind['document'])} document ingestions · ${countOf(kind['source'])} source syncs',
          ),
          if (durations.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                'Median ${durationLabel(durations['p50'])} · P95 ${durationLabel(durations['p95'])} · Max ${durationLabel(durations['max'])}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          if (buckets.isNotEmpty)
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              title: const Text('Throughput over time'),
              subtitle: const Text('Started / completed / unsuccessful'),
              children: [
                for (final bucket in buckets)
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: Text(dateLabel(bucket['start'])),
                    subtitle: Text(
                      '${countOf(bucket['started'])} started · ${countOf(bucket['completed'])} completed · ${countOf(bucket['failed'])} unsuccessful',
                    ),
                  ),
              ],
            ),
          Text(
            'Summary covers the selected time window; history filters apply only below.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}

class IngestionDetailPage extends StatefulWidget {
  const IngestionDetailPage({
    super.key,
    required this.api,
    required this.session,
    required this.ingestionId,
  });
  final ApiClient api;
  final AuthSession session;
  final String ingestionId;
  @override
  State<IngestionDetailPage> createState() => _IngestionDetailPageState();
}

class _IngestionDetailPageState extends State<IngestionDetailPage>
    with WidgetsBindingObserver, IntegrationPolling<IngestionDetailPage> {
  IngestionRecord? _ingestion;
  List<JsonMap> _events = [];
  String? _error, _eventsError, _accessError;
  bool _loading = false, _busy = false, _live = true, _permissionDenied = false;
  int _generation = 0;
  bool _collectionWritable = false;
  @override
  Duration get pollingInterval => _error != null || _ingestion?.active != true
      ? const Duration(seconds: 15)
      : const Duration(seconds: 2);
  @override
  bool get pollingEnabled =>
      _live &&
      !_busy &&
      (_ingestion == null || _ingestion!.active || _eventsError != null);
  @override
  Future<void> poll() => _load(silent: true);
  @override
  void initState() {
    super.initState();
    unawaited(_load());
    startPolling();
  }

  @override
  void dispose() {
    _generation++;
    stopPolling();
    super.dispose();
  }

  Future<void> _load({bool silent = false}) async {
    if (silent && (_loading || _busy)) return;
    final generation = ++_generation;
    if (!silent) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    final eventRequest = widget.api
        .get('${resourcePath('ingestions', widget.ingestionId)}/events')
        .then<JsonMap?>(
          (value) => value,
          onError: (Object error) {
            if (mounted && generation == _generation) {
              setState(() => _eventsError = '$error');
            }
            return null;
          },
        );
    try {
      final result = await widget.api.get(
        resourcePath('ingestions', widget.ingestionId),
      );
      if (!mounted || generation != _generation) return;
      final ingestion = IngestionRecord(result);
      setState(() {
        _ingestion = ingestion;
        _error = null;
      });
      if (ingestion.kind == 'document') {
        try {
          final collection = await widget.api.get(
            resourcePath('collections', ingestion.collectionId),
          );
          if (!mounted || generation != _generation) return;
          final permissions = collection['permissions'];
          setState(() {
            _collectionWritable =
                permissions is List &&
                permissions.contains('collection.update');
            _accessError = null;
            _permissionDenied = false;
          });
        } catch (error) {
          if (mounted && generation == _generation) {
            setState(() {
              _collectionWritable = false;
              _accessError = 'Collection access could not be checked. $error';
            });
          }
        }
      }
    } catch (error) {
      if (mounted && generation == _generation) {
        setState(() => _error = '$error');
      }
    } finally {
      final events = await eventRequest;
      if (mounted && generation == _generation) {
        setState(() {
          _loading = false;
          if (events != null) {
            _events = objectList(events['items']);
            _eventsError = null;
          }
        });
        schedulePoll();
      }
    }
  }

  bool get _canOperate =>
      !_permissionDenied &&
      (_ingestion?.kind == 'source'
          ? widget.session.can('source.manage')
          : _collectionWritable);
  Future<void> _operate(String operation) async {
    final ingestion = _ingestion;
    if (_busy || ingestion == null || !_canOperate) return;
    if (operation == 'retry' && !ingestion.retryable ||
        operation == 'cancel' &&
            (!ingestion.active || ingestion.mode == 'direct')) {
      return;
    }
    if (operation == 'cancel' &&
        !await confirmIntegration(
          context,
          title: 'Cancel this ingestion?',
          message: 'Work already indexed may remain in the collection. You can retry the ingestion after cancellation.',
          action: 'Cancel ingestion',
        )) {
      return;
    }
    if (!mounted) return;
    _generation++;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await widget.api.post(
        '${resourcePath('ingestions', widget.ingestionId)}/$operation',
      );
      if (!mounted) return;
      setState(() => _ingestion = IngestionRecord(result));
      integrationToast(
        context,
        operation == 'retry' ? 'Retry requested' : 'Cancellation requested',
      );
      await _load();
    } catch (error) {
      if (mounted) {
        setState(() {
          if (error is ApiException &&
              (error.status == 403 || error.status == 404)) {
            _permissionDenied = true;
            _error = 'This operation needs update access to the destination collection, or the ingestion is no longer available.';
          } else {
            _error = '$error';
          }
        });
      }
    } finally {
      if (mounted) {
        setState(() => _busy = false);
        schedulePoll();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final ingestion = _ingestion;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Ingestion detail'),
        actions: [
          IconButton(
            tooltip: _live ? 'Pause live updates' : 'Resume live updates',
            onPressed: () {
              setState(() => _live = !_live);
              schedulePoll();
              if (_live) unawaited(_load(silent: true));
            },
            icon: Icon(
              _live ? Icons.pause_circle_outline : Icons.play_circle_outline,
            ),
          ),
          IconButton(
            tooltip: 'Refresh ingestion',
            onPressed: _loading || _busy ? null : () => _load(),
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: IntegrationBody(
        onRefresh: _load,
        children: [
          if (_error != null)
            IntegrationNotice(
              message: _error!,
              error: true,
              onRetry: () => _load(),
            ),
          if (_loading || _busy)
            const Padding(
              padding: EdgeInsets.only(bottom: 16),
              child: LinearProgressIndicator(),
            ),
          if (ingestion != null) ...[
            IntegrationCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    ingestion.title,
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 12),
                  StatusBadge(ingestion.status),
                  const SizedBox(height: 16),
                  Text(
                    ingestion.progressLabel,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  if (ingestion.active)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      child: LinearProgressIndicator(
                        value: ingestion.progressRatio,
                      ),
                    ),
                  if (ingestion.error.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 16),
                      child: IntegrationNotice(
                        message: ingestion.error,
                        error: true,
                      ),
                    ),
                  Wrap(
                    spacing: 16,
                    runSpacing: 8,
                    children: [
                      for (final metric in const {
                        'discovered_count': 'Discovered',
                        'processed_count': 'Processed',
                        'indexed_count': 'Indexed',
                        'deleted_count': 'Deleted',
                        'failed_count': 'Failed',
                      }.entries)
                        if (ingestion.progress.containsKey(metric.key))
                          Chip(
                            label: Text(
                              '${metric.value}: ${countOf(ingestion.progress[metric.key])}',
                            ),
                          ),
                    ],
                  ),
                  DetailLine('Attempt', '${ingestion.attempt}'),
                  DetailLine('Trigger', readable(ingestion.trigger)),
                  DetailLine(
                    'Runner',
                    ingestion.mode == 'managed'
                        ? 'Workspace ingestion'
                        : 'Personal document ingestion',
                  ),
                  DetailLine('Started', dateLabel(ingestion.startedAt)),
                  DetailLine('Finished', dateLabel(ingestion.finishedAt)),
                  DetailLine('Duration', durationLabel(ingestion.durationMs)),
                  if (ingestion.collectionId.isNotEmpty)
                    DetailLine(
                      'Destination collection',
                      ingestion.collectionId,
                    ),
                  if (_canOperate)
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        if (ingestion.retryable)
                          FilledButton.icon(
                            onPressed: _busy ? null : () => _operate('retry'),
                            icon: const Icon(Icons.replay),
                            label: const Text('Retry ingestion'),
                          ),
                        if (ingestion.active && ingestion.mode != 'direct')
                          OutlinedButton.icon(
                            onPressed: _busy ? null : () => _operate('cancel'),
                            icon: const Icon(Icons.stop_circle_outlined),
                            label: const Text('Cancel ingestion'),
                          ),
                      ],
                    ),
                  if (_accessError != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: IntegrationNotice(
                        message: _accessError!,
                        error: true,
                        onRetry: () => _load(),
                      ),
                    ),
                  if (ingestion.kind == 'document' &&
                      !_collectionWritable &&
                      _accessError == null &&
                      (ingestion.retryable || ingestion.active))
                    const Padding(
                      padding: EdgeInsets.only(top: 12),
                      child: Text(
                        'Retry and cancel require update access to this collection.',
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 24),
            Text(
              'Activity timeline',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 12),
            if (_eventsError != null)
              IntegrationNotice(
                message: _eventsError!,
                error: true,
                onRetry: () => _load(),
              ),
            if (_events.isEmpty && !_loading && _eventsError == null)
              const IntegrationEmpty(
                title: 'No events reported yet',
                message:
                    'Events appear as the worker starts and changes phases.',
                icon: Icons.timeline,
              ),
            if (_events.isNotEmpty)
              IntegrationCard(
                child: Column(
                  children: [
                    for (var index = 0; index < _events.length; index++)
                      _EventTile(
                        event: _events[index],
                        last: index == _events.length - 1,
                      ),
                  ],
                ),
              ),
          ],
        ],
      ),
    );
  }
}

class _EventTile extends StatelessWidget {
  const _EventTile({required this.event, required this.last});
  final JsonMap event;
  final bool last;
  @override
  Widget build(BuildContext context) {
    final type = textOf(event['type']);
    final bad = const {'failed', 'timed_out'}.contains(type);
    return Padding(
      padding: EdgeInsets.only(bottom: last ? 0 : 20),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            bad
                ? Icons.error_outline
                : type == 'completed'
                ? Icons.check_circle_outline
                : type == 'cancelled'
                ? Icons.stop_circle_outlined
                : Icons.radio_button_checked,
            size: 22,
            color: bad ? context.colors.danger : context.colors.brand,
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  type == 'phase'
                      ? readable(textOf(event['phase']))
                      : readable(type),
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                if (textOf(event['message']).isNotEmpty)
                  Text(textOf(event['message'])),
                Text(
                  '${dateLabel(event['at'])}${event['attempt'] == null ? '' : ' · Attempt ${event['attempt']}'}${event['duration_ms'] == null ? '' : ' · ${durationLabel(event['duration_ms'])}'}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ActivityResourcePicker extends StatefulWidget {
  const _ActivityResourcePicker({required this.api, required this.resource});
  final ApiClient api;
  final String resource;
  @override
  State<_ActivityResourcePicker> createState() =>
      _ActivityResourcePickerState();
}

class _ActivityResourcePickerState extends State<_ActivityResourcePicker> {
  List<JsonMap> _items = [];
  String? _error;
  int _page = 1, _total = 0;
  bool _busy = false;
  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await widget.api.get(
        '/${widget.resource}',
        query: {'page': _page, 'page_size': 20},
      );
      if (mounted) {
        setState(() {
          _items = objectList(result['items']);
          _total = countOf(result['total']);
        });
      }
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text('Choose ${widget.resource}')),
    body: IntegrationBody(
      children: [
        if (_error != null)
          IntegrationNotice(message: _error!, error: true, onRetry: _load),
        if (_busy) const LinearProgressIndicator(),
        if (!_busy && _items.isEmpty && _error == null)
          const IntegrationEmpty(
            title: 'No matching resources',
            message: 'Only resources available to your account are listed.',
          ),
        for (final item in _items)
          ListTile(
            title: Text(
              textOf(
                item['title'],
                textOf(item['display_name'], 'Knowledge resource'),
              ),
            ),
            trailing: const Icon(Icons.chevron_right),
            onTap: _busy ? null : () => Navigator.pop(context, item),
          ),
        IntegrationPager(
          page: _page,
          total: _total,
          pageSize: 20,
          busy: _busy,
          onPage: (page) {
            _page = page;
            unawaited(_load());
          },
        ),
      ],
    ),
  );
}
