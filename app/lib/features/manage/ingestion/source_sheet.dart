import 'package:flutter/material.dart';

import '../../../core/api_client.dart';
import '../../../ui/ui.dart';
import 'ingestion_models.dart';

/// A source's state, as a word with its colour.
StatusPill sourceStatusPill(JsonMap source) {
  if (textOf(objectOf(source['sync'])['status']) == 'running') {
    return const StatusPill(label: 'Syncing', tone: StatusTone.info);
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

class _SourceBodyState extends State<_SourceBody> {
  late JsonMap _schedule = objectOf(widget.source['schedule']);
  bool _savingSchedule = false;
  bool _syncing = false;
  Object? _error;

  String get _path =>
      '/sources/${Uri.encodeComponent(textOf(widget.source['id']))}';

  Future<void> _setSchedule(bool enabled) async {
    setState(() {
      _savingSchedule = true;
      _error = null;
    });
    try {
      final updated = await widget.api.patch(
        '$_path/schedule',
        body: {'enabled': enabled},
      );
      if (!mounted) return;
      setState(
        () => _schedule = updated.isEmpty
            ? {..._schedule, 'enabled': enabled}
            : updated,
      );
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _savingSchedule = false);
    }
  }

  Future<void> _syncNow() async {
    setState(() {
      _syncing = true;
      _error = null;
    });
    try {
      await widget.api.post('$_path/syncs');
      if (!mounted) return;
      showToast(context, 'Sync started');
      Navigator.pop(context);
    } catch (error) {
      if (mounted) {
        setState(() {
          _syncing = false;
          _error = error;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final source = widget.source;
    final sync = objectOf(source['sync']);
    final status = textOf(source['status']);
    final pending = intOf(source['pending_documents']);
    final lastSynced = sync['last_synced_at'];
    final syncable =
        widget.canSync &&
        status != 'connection_required' &&
        status != 'disabled' &&
        textOf(sync['status']) != 'running';
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SelectRow(
          label: 'Status',
          value: sourceStatusPill(source).label,
          trailing: sourceStatusPill(source),
        ),
        const SizedBox(height: 8),
        SelectRow(
          label: 'Last sync',
          value: lastSynced == null
              ? 'Not synced yet'
              : '${sentenceCase(relativeTime(lastSynced))} · ${syncChanges(sync)}',
        ),
        if (textOf(sync['error']).isNotEmpty) ...[
          const SizedBox(height: 8),
          InlineNotice(
            text: plainReason(
              textOf(sync['error']),
              fallback: 'The last sync didn’t finish.',
            ),
            icon: Icons.warning_amber_rounded,
            tone: StatusTone.danger,
          ),
        ],
        if (_schedule.isNotEmpty) ...[
          const SizedBox(height: 8),
          SelectRow(
            label: 'Schedule',
            value: _schedule['enabled'] == true
                ? scheduleCadence(_schedule, short: false)
                : 'Paused · ${scheduleCadence(_schedule)}',
            trailing: Switch(
              value: _schedule['enabled'] == true,
              onChanged: widget.canSync && !_savingSchedule
                  ? _setSchedule
                  : null,
            ),
          ),
        ],
        if (status == 'connection_required') ...[
          const SizedBox(height: 8),
          const InlineNotice(
            text: 'Sign in to this source again from BoMesh on the web.',
            icon: Icons.power_outlined,
            tone: StatusTone.warning,
          ),
        ],
        if (pending > 0) ...[
          const SizedBox(height: 10),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Text(
              '${countOf(pending, 'document')} from this source ${pending == 1 ? 'is' : 'are'} not searchable yet.',
              style: TextStyle(color: colors.ink3, fontSize: 13),
            ),
          ),
        ],
        if (_error != null) ...[
          const SizedBox(height: 8),
          InlineNotice(text: friendlyError(_error!), tone: StatusTone.warning),
        ],
        if (syncable) ...[
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: _syncing ? null : _syncNow,
            icon: _syncing
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.refresh_rounded, size: 18),
            label: const Text('Sync now'),
          ),
        ],
      ],
    );
  }
}
