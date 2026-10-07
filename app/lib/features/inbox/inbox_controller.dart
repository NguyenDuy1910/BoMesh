import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/api_client.dart';
import '../auth/session.dart';

enum InboxKind { request, source, connection }

@immutable
class InboxItem {
  const InboxItem({required this.key, required this.kind, required this.title,
    required this.detail, required this.resource, this.time});
  final String key, title, detail;
  final InboxKind kind;
  final JsonMap resource;
  final DateTime? time;
}

/// A projection of authorized resource reads, not a notifications service.
/// Read markers belong to this API origin, account and workspace on this device.
class InboxController extends ChangeNotifier {
  InboxController(this.api, this.session, {SharedPreferencesAsync? preferences})
      : _preferences = preferences ?? SharedPreferencesAsync();
  final ApiClient api;
  final AuthSession session;
  final SharedPreferencesAsync _preferences;
  String get _storageKey => 'bomesh.inbox.read:${Uri.encodeComponent(api.baseUrl)}:${Uri.encodeComponent(session.namespace)}';
  List<InboxItem> items = const [];
  List<String> errors = const [];
  Set<String> _read = {};
  bool loading = true;
  bool _disposed = false;
  bool _restored = false;
  Future<void>? _loading;
  Future<void> _writes = Future.value();

  int get unread => items.where((item) => !isRead(item)).length;
  bool isRead(InboxItem item) => _read.contains(item.key);

  Future<void> refresh() => _loading ??= _load().whenComplete(() => _loading = null);

  Future<void> _load() async {
    final next = <InboxItem>[];
    final failures = <String>[];
    if (!_restored) {
      try {
        _read = (await _preferences.getStringList(_storageKey) ?? []).toSet();
        _restored = true;
      } catch (_) {
        failures.add('Read status could not be restored on this device.');
      }
    }
    Future<void> load(String path, void Function(JsonMap) add) async {
      try {
        for (final row in await readAllPages(api, path)) { add(row); }
      } catch (error) {
        failures.add('${switch (path) { '/approval-requests' => 'Access requests', '/sources' => 'Sources', _ => 'Connected accounts' }}: $error');
      }
    }
    DateTime? time(JsonMap row) => DateTime.tryParse(textOf(row['updated_at'] ?? row['created_at']));
    await Future.wait([
      load('/approval-requests', (row) {
        final person = objectOf(row['requester']);
        final own = textOf(person['id']) == session.userId;
        final pending = row['status'] == 'pending';
        final resource = row['request_type'] == 'resource_access';
        if (!own && (!pending || !session.can(resource ? 'access.manage' : 'source.manage'))) return;
        final name = textOf(person['display_name']).trim();
        final requester = name.isNotEmpty ? name : textOf(person['email'], 'Someone');
        final status = textOf(row['status']);
        next.add(InboxItem(
          key: 'request:${row['id']}:$status', kind: InboxKind.request,
          title: own ? (pending ? 'Your access request is waiting' : 'Your access request was $status') : '$requester requested ${resource ? 'knowledge' : 'connector'} access',
          detail: textOf(own && !pending ? row['decision_note'] : row['reason'], pending ? 'Open the request to see the next step.' : 'Open to review the decision.'),
          resource: row, time: time(row),
        ));
      }),
      if (session.can('source.manage')) ...[
        load('/sources', (row) {
          final sync = objectOf(row['sync']);
          if (!['failed', 'connection_required'].contains(row['status']) && sync['status'] != 'failed' && intOf(sync['failed']) == 0) return;
          final name = textOf(row['display_name'], 'A source');
          next.add(InboxItem(
            key: 'source:${row['id']}:${row['status']}:${sync['last_synced_at']}:${sync['error']}',
            kind: InboxKind.source, title: '$name needs attention',
            detail: textOf(sync['error'], row['status'] == 'connection_required' ? 'Reconnect the account to resume syncing.' : 'Open the source to check its latest sync.'),
            resource: row, time: time(row),
          ));
        }),
        load('/connections', (row) {
          if (!['expired', 'reauth_required', 'revoked', 'error', 'disconnected'].contains(row['status'])) return;
          next.add(InboxItem(
            key: 'connection:${row['id']}:${row['status']}:${row['updated_at']}', kind: InboxKind.connection,
            title: '${textOf(row['display_name'], 'A connected account')} needs attention',
            detail: textOf(row['status_detail'], 'Open Accounts to restore access.'), resource: row, time: time(row),
          ));
        }),
      ],
    ]);
    if (_disposed) return;
    next.sort((a, b) => (b.time ?? DateTime(1970)).compareTo(a.time ?? DateTime(1970)));
    items = next;
    errors = failures;
    loading = false;
    notifyListeners();
  }

  Future<void> markRead(InboxItem item, {bool read = true}) {
    if (read) { _read.add(item.key); } else { _read.remove(item.key); }
    return _save();
  }

  Future<void> markAllRead() {
    _read.addAll(items.map((item) => item.key));
    return _save();
  }

  Future<void> _save() {
    final values = _read.toList();
    notifyListeners();
    final pending = _writes.then((_) => _preferences.setStringList(_storageKey, values));
    _writes = pending.catchError((Object _) {});
    return pending;
  }

  @override
  void dispose() { _disposed = true; super.dispose(); }
}
