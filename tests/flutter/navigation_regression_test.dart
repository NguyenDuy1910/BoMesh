import 'package:bomesh/app/app_theme.dart';
import 'package:bomesh/app/appearance.dart';
import 'package:bomesh/app/workspace_scope.dart';
import 'package:bomesh/core/api_client.dart';
import 'package:bomesh/features/auth/session.dart';
import 'package:bomesh/features/chat/chat_page.dart';
import 'package:bomesh/features/chat/models/chat_models.dart';
import 'package:bomesh/features/chat/services/conversation_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences_platform_interface/in_memory_shared_preferences_async.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_async_platform_interface.dart';

AuthSession session() => AuthSession.fromJson({
  'access_token': 'token',
  'session_id': 'session',
  'user_id': 'user',
  'active_workspace_id': 'workspace',
  'expires_at': DateTime.now().add(const Duration(hours: 1)).toIso8601String(),
  'permissions': ['knowledge.read', 'knowledge.manage'],
  'workspaces': [
    {'id': 'workspace', 'name': 'Workspace', 'code': 'workspace'},
  ],
});

void main() {
  setUp(
    () => SharedPreferencesAsyncPlatform.instance =
        InMemorySharedPreferencesAsync.empty(),
  );

  testWidgets(
    'rename from History stays mounted while its sheet closes and persists the new title',
    (tester) async {
      final api = ApiClient(
        client: MockClient(
          (request) async => http.Response('{"items":[],"total":0}', 200),
        ),
      )..accessToken = 'token';
      final identity = session();
      final store = ConversationStore(namespace: identity.namespace);
      await store.saveConversation('chat', 'Original title', [
        ChatMessage(
          id: 'question',
          role: ChatRole.user,
          text: 'Hello',
          createdAt: DateTime.now(),
        ),
      ]);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: WorkspaceScope(
            api: api,
            session: identity,
            auth: SessionController(api),
            appearance: AppearanceController(),
            askAboutDocument: (_, _) {},
            waitingRequests: 0,
            refreshWaitingRequests: () async {},
            child: const ChatPage(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('History'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Chat actions'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Rename'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.descendant(
          of: find.byType(BottomSheet),
          matching: find.byType(TextField),
        ),
        'Renamed title',
      );
      await tester.tap(find.text('Save'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.takeException(), isNull);
      await tester.pumpAndSettle();
      expect(find.text('Renamed title'), findsOneWidget);
      expect((await store.listConversations()).single.title, 'Renamed title');
      await tester.pumpWidget(const SizedBox.shrink());
      api.close();
    },
  );
}
