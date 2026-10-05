import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../../core/api_client.dart';
import '../../../ui/ui.dart';

/// One ingestion run (`IngestionRun`), read in the words the app shows.
class IngestionRun {
  IngestionRun.fromJson(JsonMap json)
    : id = textOf(json['id']),
      status = textOf(json['status'], 'queued'),
      trigger = textOf(json['trigger'], 'manual'),
      collectionId = _id(objectOf(json['scope'])['collection_id']),
      sourceId = _id(objectOf(json['scope'])['source_id']),
      retryOfRunId = _id(objectOf(json['scope'])['retry_of_run_id']),
      selectedDocuments = objectOf(json['scope'])['selected_documents'] == null
          ? null
          : intOf(objectOf(json['scope'])['selected_documents']),
      total = intOf(objectOf(json['counts'])['total']),
      succeeded = intOf(objectOf(json['counts'])['succeeded']),
      failed = intOf(objectOf(json['counts'])['failed']),
      skipped = intOf(objectOf(json['counts'])['skipped']),
      cancelled = intOf(objectOf(json['counts'])['cancelled']),
      error = _id(json['error']),
      creatorId = _id(objectOf(json['created_by'])['id']),
      creatorName = _personName(objectOf(json['created_by'])),
      createdAt = parseTime(json['created_at']),
      startedAt = parseTime(json['started_at']),
      finishedAt = parseTime(json['finished_at']);

  final String id, status, trigger;
  final String? collectionId, sourceId, retryOfRunId, creatorId, creatorName;

  /// Why the whole run stopped, in the server's own words.
  final String? error;
  final int? selectedDocuments;
  final int total, succeeded, failed, skipped, cancelled;
  final DateTime? createdAt, startedAt, finishedAt;

  bool get active => status == 'queued' || status == 'running';

  /// Documents that reached an outcome, of [total].
  int get done => succeeded + failed + skipped + cancelled;

  /// What a retry would take again.
  int get retryable => failed + cancelled + skipped;
  bool get isRetry => retryOfRunId != null;
  bool startedBy(String userId) => creatorId != null && creatorId == userId;

  /// "you", a name, or the schedule.
  String starter(String userId) {
    if (startedBy(userId)) return 'you';
    if (creatorName != null) return creatorName!;
    return trigger == 'scheduled' ? 'a schedule' : 'someone';
  }

  StatusPill get pill => switch (status) {
    'queued' => const StatusPill(label: 'Queued', tone: StatusTone.info),
    'running' => const StatusPill(label: 'Running', tone: StatusTone.info),
    'cancelled' => const StatusPill(
      label: 'Cancelled',
      tone: StatusTone.neutral,
    ),
    'failed' => const StatusPill(label: 'Failed', tone: StatusTone.danger),
    _ when failed > 0 => StatusPill(
      label: '${groupedNumber(failed)} failed',
      tone: StatusTone.danger,
    ),
    _ => const StatusPill(label: 'Done', tone: StatusTone.success),
  };

  /// The run's mark: its collection's tone, or a plug for a source.
  Widget tile({TileSize size = TileSize.small}) {
    if (collectionId != null) {
      return ToneTile(
        tone: toneFor(collectionId!),
        icon: Icons.menu_book_outlined,
        size: size,
      );
    }
    if (sourceId != null) {
      return ToneTile(tone: Tone.sky, icon: Icons.power_outlined, size: size);
    }
    return ToneTile(
      tone: Tone.slate,
      icon: Icons.menu_book_outlined,
      size: size,
    );
  }
}

String? _id(Object? value) {
  final text = textOf(value);
  return text.isEmpty ? null : text;
}

String? _personName(JsonMap person) {
  final name = textOf(person['display_name']).trim();
  if (name.isNotEmpty) return name;
  final email = textOf(person['email']).trim();
  return email.isEmpty ? null : email;
}

/// Collection titles and source names, each read once per screen.
class RunNames {
  RunNames(this.api);
  final ApiClient api;
  final Map<String, Future<String>> _collections = {};
  final Map<String, Future<String>> _sources = {};

  Future<String> collection(String id) => _collections.putIfAbsent(
    id,
    () => api
        .get('/collections/${Uri.encodeComponent(id)}')
        .then((value) => textOf(value['title'], 'Untitled collection'))
        .catchError(
          (Object error) => error is ApiException && error.status == 404
              ? 'Removed collection'
              : 'A collection',
        ),
  );

  void rememberCollection(String id, String title) =>
      _collections[id] = Future.value(title);

  Future<String> source(String id) => _sources.putIfAbsent(
    id,
    () => api
        .get('/sources/${Uri.encodeComponent(id)}')
        .then(sourceName)
        .catchError((Object _) => 'A source'),
  );

  /// "Policies", "Confluence · HR space", "Selected documents",
  /// with " · retry" for a retry.
  Future<String> title(IngestionRun run) async {
    final base = run.collectionId != null
        ? await collection(run.collectionId!)
        : run.sourceId != null
        ? await source(run.sourceId!)
        : 'Selected documents';
    return run.isRetry ? '$base · retry' : base;
  }
}

/// A source's name as its owner would recognise it.
String sourceName(JsonMap source) {
  final name = textOf(source['display_name']).trim();
  if (name.isNotEmpty) return name;
  final type = textOf(source['resource_type']).trim();
  return type.isEmpty ? 'Source' : sentenceCase(type);
}

/// A failure reason a person can read: the first sentence the server gave,
/// never an exception class or a stack trace.
String plainReason(
  String? error, {
  String fallback = 'Couldn’t be made searchable',
}) {
  final text = (error ?? '').trim();
  if (text.isEmpty) return fallback;
  var line = text.split('\n').first.trim();
  if (line.startsWith('Traceback') || line.contains('File "')) return fallback;
  line = line.replaceFirst(
    RegExp(r'^([A-Za-z_][\w.]*)?(Error|Exception)\s*[:(]\s*'),
    '',
  );
  line = line.replaceFirst(RegExp(r'\)$'), '').trim();
  if (line.isEmpty) return fallback;
  if (line.length > 120) line = '${line.substring(0, 117).trimRight()}…';
  return '${line[0].toUpperCase()}${line.substring(1)}';
}

/// Polls while there is something live to watch and the screen is actually
/// visible: its tab is current, nothing covers its route, and the app is in
/// the foreground.
mixin LivePolling<T extends StatefulWidget> on State<T> {
  Timer? _timer;
  ValueListenable<TickerModeData>? _tickerMode;
  AppLifecycleListener? _lifecycle;
  bool _foreground = true;
  bool _polling = false;

  Duration get pollInterval;

  /// Whether anything shown is still changing.
  bool get hasLiveWork;

  Future<void> poll();

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(
      onStateChange: (state) {
        _foreground = state == AppLifecycleState.resumed;
        syncPolling();
      },
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final notifier = TickerMode.getValuesNotifier(context);
    if (notifier != _tickerMode) {
      _tickerMode?.removeListener(syncPolling);
      _tickerMode = notifier..addListener(syncPolling);
    }
    syncPolling();
  }

  /// Starts or stops the timer to match [hasLiveWork] and visibility.
  void syncPolling() {
    final wanted =
        mounted &&
        hasLiveWork &&
        _foreground &&
        (_tickerMode?.value.enabled ?? true);
    if (wanted) {
      _timer ??= Timer.periodic(pollInterval, (_) => _tick());
    } else {
      _timer?.cancel();
      _timer = null;
    }
  }

  Future<void> _tick() async {
    if (!mounted || _polling || !(ModalRoute.isCurrentOf(context) ?? true)) {
      return;
    }
    _polling = true;
    try {
      await poll();
    } catch (_) {
      // A missed tick is retried on the next one.
    } finally {
      _polling = false;
      syncPolling();
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _tickerMode?.removeListener(syncPolling);
    _lifecycle?.dispose();
    super.dispose();
  }
}
