import 'dart:async';
import 'dart:convert';

import 'package:bomesh/core/api_client.dart';
import 'package:bomesh/features/auth/session.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> sessionPayload({
  String workspace = 'workspace-a',
  String token = 'token-a',
  DateTime? expires,
}) => {
  'access_token': token,
  'session_id': 'session-a',
  'active_workspace_id': workspace,
  'user_id': 'user-a',
  'email': 'analyst@example.com',
  'display_name': 'Analyst',
  'expires_at': (expires ?? DateTime.now().add(const Duration(hours: 1)))
      .toIso8601String(),
  'permissions': ['knowledge.read'],
  'platform_permissions': [],
  'workspaces': [
    for (final id in ['workspace-a', 'workspace-b'])
      {
        'id': id,
        'code': id,
        'name': id,
        'permissions': ['knowledge.read'],
      },
  ],
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
  });

  test('session without a user identity is rejected', () {
    for (final userId in [null, '']) {
      expect(
        () => AuthSession.fromJson({...sessionPayload(), 'user_id': userId}),
        throwsFormatException,
      );
    }
  });

  test('expired authenticated requests revoke local session, invalid login does not', () async {
    final client = ApiClient(
      client: MockClient((request) async {
        if (request.method == 'POST' &&
            jsonDecode(request.body)['password'] == 'correct-password') {
          return http.Response(
            jsonEncode(sessionPayload()),
            200,
            request: request,
          );
        }
        return http.Response(
          '{"message":"Not authenticated"}',
          401,
          request: request,
        );
      }),
    );
    final controller = SessionController(client);
    addTearDown(controller.dispose);
    addTearDown(client.close);
    expect(await controller.signIn('analyst', 'correct-password'), isTrue);
    expect(await controller.signIn('analyst', 'wrong-password'), isFalse);
    expect(controller.session, isNotNull);
    await expectLater(
      client.get('/knowledge/home'),
      throwsA(isA<ApiException>()),
    );
    expect(controller.session, isNull);
    expect(client.accessToken, isNull);
  });

  test('late 401 from old token cannot expire a replacement session', () async {
    final response = Completer<http.Response>();
    http.Request? sent;
    final client = ApiClient(
      client: MockClient((request) {
        sent = request;
        return response.future;
      }),
    );
    addTearDown(client.close);
    client.accessToken = 'old';
    var expired = false;
    client.onUnauthorized = () => expired = true;
    final request = client.get('/knowledge/home');
    await Future<void>.delayed(Duration.zero);
    client.accessToken = 'replacement';
    response.complete(http.Response('{}', 401, request: sent));
    await expectLater(request, throwsA(isA<ApiException>()));
    expect(expired, isFalse);
  });

  test(
    'failed workspace switch retains previous workspace and token',
    () async {
      final client = ApiClient(
        client: MockClient(
          (request) async => request.method == 'PATCH'
              ? http.Response(
                  '{"message":"Access denied"}',
                  403,
                  request: request,
                )
              : http.Response(
                  jsonEncode(sessionPayload()),
                  200,
                  request: request,
                ),
        ),
      );
      final controller = SessionController(client);
      addTearDown(controller.dispose);
      addTearDown(client.close);
      await controller.signIn('analyst', 'correct-password');
      expect(await controller.switchWorkspace('workspace-b'), isFalse);
      expect(controller.session!.activeWorkspaceId, 'workspace-a');
      expect(client.accessToken, 'token-a');
    },
  );

  test('session expiry wins over pending workspace replacement', () async {
    final replacement = Completer<http.Response>();
    final client = ApiClient(
      client: MockClient(
        (request) async => request.method == 'PATCH'
            ? replacement.future
            : http.Response(
                jsonEncode(sessionPayload()),
                200,
                request: request,
              ),
      ),
    );
    final controller = SessionController(client);
    addTearDown(controller.dispose);
    addTearDown(client.close);
    await controller.signIn('analyst', 'correct-password');
    final switching = controller.switchWorkspace('workspace-b');
    controller.expire();
    replacement.complete(
      http.Response(
        jsonEncode(
          sessionPayload(workspace: 'workspace-b', token: 'new-token'),
        ),
        200,
      ),
    );
    expect(await switching, isFalse);
    expect(controller.session, isNull);
    expect(client.accessToken, isNull);
  });

  test(
    'new process restores only a server-validated session from secure storage',
    () async {
      var revoked = false;
      final client = ApiClient(
        baseUrl: 'https://workspace.example',
        client: MockClient((request) async {
          if (revoked) return http.Response('{}', 401, request: request);
          final payload = sessionPayload();
          if (request.method == 'GET') payload.remove('access_token');
          return http.Response(jsonEncode(payload), 200, request: request);
        }),
      );
      addTearDown(client.close);
      final first = SessionController(client);
      await first.signIn('analyst', 'correct-password');
      first.dispose();
      revoked = true;
      final restored = SessionController(client);
      addTearDown(restored.dispose);
      await restored.restore();
      expect(restored.session, isNull);
      expect(restored.restoring, isFalse);
      expect(client.accessToken, isNull);
    },
  );

  test('API paths cannot redirect bearer credentials to another origin', () {
    final client = ApiClient(baseUrl: 'https://workspace.example/api/v1');
    addTearDown(client.close);
    expect(
      () => client.uri('https://untrusted.example/users'),
      throwsA(isA<ApiException>()),
    );
    expect(
      () => client.uri('//untrusted.example/users'),
      throwsA(isA<ApiException>()),
    );
    expect(
      client.uri('/api/v1/users', {'page': 2}).toString(),
      'https://workspace.example/api/v1/users?page=2',
    );
  });
}
