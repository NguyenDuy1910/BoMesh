import 'package:flutter/material.dart';

import '../../../app/workspace_scope.dart';
import '../../../core/api_client.dart';
import '../../../ui/ui.dart';
import 'ingestion_models.dart';
import 'connection_flow.dart';
import 'run_page.dart';

/// A source's state, as a word with its colour.
StatusPill sourceStatusPill(JsonMap source) {
  if (textOf(objectOf(source['sync'])['status']) == 'running') {
    return const StatusPill(label: 'Syncing', tone: StatusTone.info);
  }
  final sync = objectOf(source['sync']);
  if (sync['status'] == 'failed' || intOf(sync['failed']) > 0) {
    return const StatusPill(label: 'Needs attention', tone: StatusTone.danger);
  }
  return switch (textOf(source['status'])) {
    'paused' => const StatusPill(label: 'Paused', tone: StatusTone.neutral),
    'failed' => const StatusPill(label: 'Failed', tone: StatusTone.danger),
    'connection_required' => const StatusPill(
      label: 'Sign-in needed',
      tone: StatusTone.warning,
    ),
    'disabled' => const StatusPill(label: 'Off', tone: StatusTone.neutral),
    _ => const StatusPill(label: 'Ready', tone: StatusTone.success),
  };
}

/// How often a schedule syncs: "daily" in a meta line ([short]), "Every day
/// at 02:00" in detail. Expressions the app does not recognise stay generic.
String scheduleCadence(JsonMap schedule, {bool short = true}) {
  final fields = textOf(schedule['cron_expression'])
      .trim()
      .split(RegExp(r'\s+'));
  bool number(String value) => int.tryParse(value) != null;
  if (fields.length == 5) {
    final [minute, hour, day, month, weekday] = fields;
    if (minute == '0' && hour == '*' && day == '*' && weekday == '*') {
      return short ? 'hourly' : 'Every hour';
    }
    final every = RegExp(r'^\*/(\d+)$').firstMatch(hour);
    if (minute == '0' && every != null && day == '*' && weekday == '*') {
      return short
          ? 'every ${every.group(1)} hours'
          : 'Every ${every.group(1)} hours';
    }
    if (number(minute) && number(hour) && day == '*' && month == '*') {
      final at = '${hour.padLeft(2, '0')}:${minute.padLeft(2, '0')}';
      if (weekday == '*') return short ? 'daily' : 'Every day at $at';
      return short ? 'weekly' : 'Every week at $at';
    }
  }
  return short ? 'scheduled' : 'On a custom schedule';
}

/// "3 added · 2 updated", or "No changes".
String syncChanges(JsonMap sync) {
  final parts = [
    for (final (key, word) in const [
      ('added', 'added'),
      ('updated', 'updated'),
      ('removed', 'removed'),
      ('failed', 'failed'),
    ])
      if (intOf(sync[key]) > 0) '${groupedNumber(intOf(sync[key]))} $word',
  ];
  return parts.isEmpty ? 'No changes' : parts.join(' · ');
}

/// One source: its state, its last sync, and its schedule switch. The caller
/// reloads its list when the sheet closes.
Future<void> showSourceSheet(
  BuildContext context, {
  required ApiClient api,
  required JsonMap source,
  required String collectionTitle,
  required bool canSync,
}) => showAppSheet<void>(
  context,
  title: sourceName(source),
  subtitle: 'Into $collectionTitle',
  scrollable: true,
  builder: (_) => _SourceBody(api: api, source: source, canSync: canSync),
);

class _SourceBody extends StatefulWidget {
  const _SourceBody({
    required this.api,
    required this.source,
    required this.canSync,
  });
  final ApiClient api;
  final JsonMap source;
  final bool canSync;

  @override
  State<_SourceBody> createState() => _SourceBodyState();
}

class _SourceBodyState extends State<_SourceBody>
    with LivePolling<_SourceBody> {
  late JsonMap _source = widget.source;
  JsonMap? _connection;
  bool _collectionCanProcess = false;
  bool _busy = false;
  Object? _error;

  String get _path => '/sources/${Uri.encodeComponent(textOf(_source['id']))}';
  JsonMap get _schedule => objectOf(_source['schedule']);
  bool get _canManage => _connection == null
      ? widget.canSync
      : canManageConnection(context, _connection!);
  @override
  Duration get pollInterval => const Duration(seconds: 3);
  @override
  bool get hasLiveWork => objectOf(_source['sync'])['status'] == 'running';
  @override
  void initState() { super.initState(); _load(); }
  @override
  Future<void> poll() async {
    final source = await widget.api.get(_path);
    if (mounted) setState(() => _source = source);
  }
  Future<void> _load() async {
    try {
      await poll();
      final connection = await widget.api.get('/connections/${Uri.encodeComponent(textOf(_source['connection_id']))}');
      if (mounted) setState(() { _connection = connection; _error = null; });
      try {
        final collection = await widget.api.get('/collections/${Uri.encodeComponent(textOf(_source['collection_id']))}');
        if (mounted) setState(() => _collectionCanProcess = (collection['permissions'] as List?)?.contains('ingestion.run') ?? false);
      } catch (_) {
        // The source remains usable without permission to read its destination.
      }
    } catch (error) { if (mounted) setState(() => _error = error); }
    if (mounted) syncPolling();
  }
  Future<void> _act(Future<void> Function() action) async {
    setState(() { _busy = true; _error = null; });
    try { await action(); if (mounted) await _load(); }
    catch (error) { if (mounted) setState(() => _error = error); }
    finally { if (mounted) setState(() => _busy = false); }
  }
  Future<void> _editSchedule() async {
    final schedule = await showScheduleEditor(context, initial: _schedule.isEmpty ? null : _schedule);
    if (!mounted || schedule == null) return;
    await _act(() async { await widget.api.put('$_path/schedule', body: schedule); });
  }
  Future<void> _process() => _act(() async {
    final run = await widget.api.post('/ingestion-runs', body: {
      'source_id': _source['id'], 'states': ['pending', 'outdated'], 'trigger': 'manual',
    });
    if (!mounted) return;
    final id = textOf(run['id']);
    if (id.isEmpty) throw StateError('The server did not return a processing run.');
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => RunPage(runId: id)));
  });
  Future<void> _rename() async {
    final name = await promptText(context, title: 'Source name', initial: sourceName(_source), confirmLabel: 'Save changes');
    if (!mounted || name == null) return;
    await _act(() async { await widget.api.patch(_path, body: {'display_name': name}); });
  }
  Future<void> _remove() async {
    final confirmed = await confirmAction(context, title: 'Remove this source?',
      message: 'This stops future syncs from this source. This action does not offer a restore period.',
      confirmLabel: 'Remove source', destructive: true);
    if (!mounted || !confirmed) return;
    await _act(() async { await widget.api.delete(_path); if (mounted) Navigator.pop(context); });
  }
  @override
  Widget build(BuildContext context) {
    final sync = objectOf(_source['sync']);
    final status = textOf(_source['status']);
    final pending = intOf(_source['pending_documents']);
    final syncable = _canManage && !['connection_required', 'disabled', 'paused'].contains(status) && sync['status'] != 'running';
    final session = WorkspaceScope.of(context).session;
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SelectRow(label: 'Source', value: sourceName(_source), trailing: sourceStatusPill(_source)),
      if (_busy) const LinearProgressIndicator(),
      if (_error != null) InlineNotice(text: friendlyError(_error!), tone: StatusTone.danger),
      const SizedBox(height: 8),
      SelectRow(label: 'Last sync', value: sync['last_synced_at'] == null ? 'Not synced yet' : '${sentenceCase(relativeTime(sync['last_synced_at']))} · ${syncChanges(sync)}'),
      if (textOf(sync['error']).isNotEmpty) InlineNotice(text: plainReason(textOf(sync['error']), fallback: 'The last sync did not finish.'), tone: StatusTone.danger),
      if (_connection != null) ...[
        const SectionLabel('Account', first: true),
        SelectRow(value: connectionName(_connection!), label: sentenceCase(textOf(_connection!['status'])), onTap: _busy ? null : () async {
          await showConnectionSheet(context, api: widget.api, connection: _connection!);
          if (mounted) _load();
        }),
      ],
      const SectionLabel('Selected content'),
      SelectRow(label: 'Content type', value: sentenceCase(textOf(_source['resource_type'], 'Connector scope'))),
      const InlineNotice(text: 'The content and destination are fixed for this source. To choose different content or a different knowledge base, connect a new source.'),
      const SectionLabel('Schedule'),
      if (_schedule.isNotEmpty) ...[
        SelectRow(label: _schedule['enabled'] == true ? 'Automatic sync' : 'Paused schedule', value: scheduleCadence(_schedule, short: false),
          trailing: Switch(value: _schedule['enabled'] == true, onChanged: _canManage && !_busy ? (enabled) => _act(() async { await widget.api.patch('$_path/schedule', body: {'enabled': enabled}); }) : null)),
        if (_schedule['next_run_at'] != null) Text('Next sync ${relativeTime(_schedule['next_run_at'])}'),
      ] else const InlineNotice(text: 'Manual sync only. Add a schedule to sync and process changed documents automatically.'),
      if (_canManage) ...[
        OutlinedButton(onPressed: _busy ? null : _editSchedule, child: Text(_schedule.isEmpty ? 'Add schedule' : 'Edit schedule')),
        if (_schedule.isNotEmpty) TextButton(onPressed: _busy ? null : () async {
          if (!await confirmAction(context, title: 'Remove schedule?', message: 'Automatic syncing and processing will stop. Manual sync remains available.', confirmLabel: 'Remove schedule') || !mounted) return;
          await _act(() async { await widget.api.delete('$_path/schedule'); });
        }, child: const Text('Remove schedule')),
      ],
      if (pending > 0) ...[
        const SectionLabel('Waiting for processing'),
        InlineNotice(text: '${countOf(pending, 'document')} from this source still needs processing before it is searchable.'),
        if (session.can('ingestion.run') || _collectionCanProcess) FilledButton(onPressed: _busy ? null : _process, child: const Text('Process waiting documents')),
      ],
      if (syncable) FilledButton.icon(onPressed: _busy ? null : () => _act(() async { await widget.api.post('$_path/syncs'); }),
        icon: const Icon(Icons.refresh_rounded), label: const Text('Sync now')),
      if (_canManage) ...[
        OutlinedButton(onPressed: _busy ? null : _rename, child: const Text('Rename source')),
        OutlinedButton(onPressed: _busy || (status == 'connection_required' && _connection?['status'] != 'connected') ? null : () => _act(() async {
          await widget.api.patch(_path, body: {'status': ['paused', 'disabled', 'connection_required'].contains(status) ? 'ready' : 'paused'});
        }), child: Text(['paused', 'disabled', 'connection_required'].contains(status) ? 'Resume source' : 'Pause source')),
        TextButton(onPressed: _busy ? null : _remove, child: const Text('Remove source')),
      ],
      TextButton(onPressed: _busy ? null : _load, child: const Text('Refresh source')),
    ]);
  }
}
