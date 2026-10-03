import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/api_client.dart';

class AuthWorkspace {
  AuthWorkspace.fromJson(JsonMap json)
    : id = textOf(json['id']),
      code = textOf(json['code']),
      name = textOf(json['name']),
      permissions = _strings(json['permissions']);
  final String id, code, name;
  final Set<String> permissions;
}

Set<String> _strings(Object? value) =>
    value is List ? value.whereType<String>().toSet() : <String>{};

class AuthSession {
  AuthSession.fromJson(JsonMap json)
    : accessToken = textOf(json['access_token']),
      sessionId = textOf(json['session_id']),
      activeWorkspaceId = textOf(json['active_workspace_id']),
      userId = textOf(json['user_id']),
      email = json['email'] as String?,
      displayName = json['display_name'] as String?,
      expiresAt = DateTime.parse(textOf(json['expires_at'])),
      workspaces = objectList(json['workspaces'])
          .map(AuthWorkspace.fromJson)
          .toList(),
      permissions = _strings(json['permissions']),
      platformPermissions = _strings(json['platform_permissions']) {
    if (accessToken.isEmpty ||
        sessionId.isEmpty ||
        activeWorkspaceId.isEmpty ||
        userId.isEmpty) {
      throw const FormatException('Incomplete session response.');
    }
  }
  final String accessToken, sessionId, activeWorkspaceId, userId;
  final String? email, displayName;
  final DateTime expiresAt;
  final List<AuthWorkspace> workspaces;
  final Set<String> permissions, platformPermissions;
  bool can(String permission) => permissions.contains(permission);
  bool canAny(Iterable<String> values) => values.any(can);
  String get namespace => '$userId:$activeWorkspaceId';
  String get workspaceName =>
      workspaces
          .where((item) => item.id == activeWorkspaceId)
          .map((item) => item.name)
          .firstOrNull ??
      'Workspace';
}

/// The backend has expiring access sessions, not a refresh-token endpoint.
/// Restoring and resuming always revalidates the bearer against /auth/session.
class SessionController extends ChangeNotifier {
  SessionController(this.api, {FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage() {
    api.onUnauthorized = expire;
  }
  final ApiClient api;
  final FlutterSecureStorage _storage;
  String get _storageKey =>
      'bomesh.session.${Uri.encodeComponent(api.baseUrl)}';
  AuthSession? session;
  bool restoring = true;
  bool busy = false;
  String? error;
  String? notice;
  Timer? _expiry;
  int _generation = 0;
  bool _disposed = false;
  Future<void> _writes = Future<void>.value();

  Future<void> _persist(String? token) {
    _writes = _writes
        .catchError((Object _) {})
        .then(
          (_) => token == null
              ? _storage.delete(key: _storageKey)
              : _storage.write(key: _storageKey, value: token),
        );
    return _writes;
  }

  Future<void> restore() async {
    final generation = ++_generation;
    restoring = true;
    error = null;
    _notify();
    try {
      final token = await _storage.read(key: _storageKey);
      if (_disposed || generation != _generation) return;
      if (token != null && token.isNotEmpty) {
        api.accessToken = token;
        final data = await api.get('/auth/session');
        if (_disposed || generation != _generation) return;
        _accept({...data, 'access_token': token});
      }
    } catch (caught) {
      if (_disposed || generation != _generation) return;
      api.accessToken = null;
      error = caught.toString();
    } finally {
      if (!_disposed && generation == _generation) {
        restoring = false;
        _notify();
      }
    }
  }

  Future<bool> signIn(String identifier, String password) =>
      _authenticate('/auth/sessions', {
        'method': 'password',
        identifier.contains('@') ? 'email' : 'username': identifier.trim(),
        'password': password,
      });
  Future<bool> register({
    required String email,
    required String password,
    required String displayName,
    String? username,
  }) => _authenticate('/auth/accounts', {
    'email': email.trim(),
    'password': password,
    if (displayName.trim().isNotEmpty) 'display_name': displayName.trim(),
    if (username?.trim().isNotEmpty ?? false) 'username': username!.trim(),
  });
  Future<bool> google(String credential) => _authenticate('/auth/sessions', {
    'method': 'google',
    'credential': credential,
  });

  Future<bool> _authenticate(String path, JsonMap body) async {
    if (busy) return false;
    final generation = ++_generation;
    busy = true;
    error = null;
    notice = null;
    _notify();
    try {
      final data = await api.post(path, body: body);
      if (_disposed || generation != _generation) return false;
      final next = AuthSession.fromJson(data);
      if (!next.expiresAt.isAfter(DateTime.now())) {
        throw const ApiException(
          'The server issued an expired session. Sign in again.',
        );
      }
      try {
        await _persist(next.accessToken);
      } catch (_) {
        notice = 'Signed in for this visit. Secure storage is unavailable, so you will need to sign in again after closing the app.';
      }
      if (_disposed || generation != _generation) return false;
      _accept(data);
      return true;
    } catch (caught) {
      if (!_disposed && generation == _generation) error = caught.toString();
      return false;
    } finally {
      if (!_disposed && generation == _generation) {
        busy = false;
        _notify();
      }
    }
  }

  void _accept(JsonMap data) {
    final next = AuthSession.fromJson(data);
    final remaining = next.expiresAt.difference(DateTime.now());
    if (remaining <= Duration.zero) {
      expire();
      return;
    }
    session = next;
    api.accessToken = next.accessToken;
    error = null;
    _expiry?.cancel();
    _expiry = Timer(remaining, expire);
  }

  Future<void> refresh() async {
    final current = session;
    if (current == null || busy) return;
    if (!current.expiresAt.isAfter(DateTime.now())) {
      expire();
      return;
    }
    final generation = _generation;
    final data = await api.get('/auth/session');
    if (_disposed || generation != _generation) return;
    _accept({...data, 'access_token': current.accessToken});
    _notify();
  }

  Future<bool> switchWorkspace(String id) async {
    if (busy || id == session?.activeWorkspaceId) return false;
    final generation = ++_generation;
    busy = true;
    error = null;
    _notify();
    try {
      final data = await api.patch(
        '/auth/session',
        body: {'active_workspace_id': id},
      );
      if (_disposed || generation != _generation) return false;
      final next = AuthSession.fromJson(data);
      if (!next.expiresAt.isAfter(DateTime.now())) {
        throw const ApiException(
          'The server issued an expired session. Sign in again.',
        );
      }
      try {
        await _persist(next.accessToken);
      } catch (_) {
        notice = 'Workspace changed for this visit. Secure storage could not remember the session.';
      }
      if (_disposed || generation != _generation) return false;
      _accept(data);
      return true;
    } catch (caught) {
      if (!_disposed && generation == _generation) error = caught.toString();
      return false;
    } finally {
      if (!_disposed && generation == _generation) {
        busy = false;
        _notify();
      }
    }
  }

  void expire() {
    ++_generation;
    _expiry?.cancel();
    session = null;
    api.accessToken = null;
    restoring = false;
    busy = false;
    notice = 'Your session has expired. Sign in to continue.';
    unawaited(_persist(null).catchError((Object _) {}));
    _notify();
  }

  Future<void> signOut() async {
    if (busy) return;
    busy = true;
    _notify();
    String? warning;
    try {
      await api.delete('/auth/session');
    } catch (_) {
      warning = 'Signed out on this device. The server could not confirm session revocation.';
    }
    ++_generation;
    _expiry?.cancel();
    session = null;
    api.accessToken = null;
    try {
      await _persist(null);
    } catch (_) {
      warning = 'Local secure storage could not be cleared. Close the app and retry sign out.';
    }
    notice = warning;
    error = null;
    busy = false;
    _notify();
  }

  void dismissNotice() {
    notice = null;
    _notify();
  }

  void clearError() {
    error = null;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    ++_generation;
    _expiry?.cancel();
    api.onUnauthorized = null;
    super.dispose();
  }
}
