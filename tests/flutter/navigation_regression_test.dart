import 'package:bomesh/core/api_client.dart';
import 'package:bomesh/features/auth/session.dart';
import 'package:bomesh/features/chat/models/chat_models.dart';
import 'package:bomesh/features/chat/services/chat_service.dart';
import 'package:bomesh/features/chat/services/conversation_store.dart';
import 'package:bomesh/features/chat/state/chat_controller.dart';
import 'package:bomesh/features/chat/widgets/app_sidebar.dart';
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
    'rename remains mounted during dialog exit and persists new title',
    (tester) async {
      final api = ApiClient(
        client: MockClient(
          (request) async => http.Response('{"items":[],"total":0}', 200),
        ),
      )..accessToken = 'token';
      final store = ConversationStore(namespace: 'rename:workspace');
      await store.saveConversation('chat', 'Original title', [
        ChatMessage(
          id: 'question',
          role: ChatRole.user,
          text: 'Hello',
          createdAt: DateTime.now(),
        ),
      ]);
      final controller = ChatController(ChatService(api), store, session());
      await controller.initialize();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: controller,
              builder: (_, _) => ChatSidebar(
                controller: controller,
                collapsed: false,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Conversation actions'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Rename'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextFormField), 'Renamed title');
      await tester.tap(find.text('Save'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.takeException(), isNull);
      await tester.pumpAndSettle();
      expect(find.text('Renamed title'), findsOneWidget);
      expect((await store.listConversations()).single.title, 'Renamed title');
      await tester.pumpWidget(const SizedBox.shrink());
      controller.dispose();
      api.close();
    },
  );
}
