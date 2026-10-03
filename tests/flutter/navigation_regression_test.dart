import 'dart:async';
import 'dart:convert';

import 'package:bothesis/core/api_client.dart';
import 'package:bothesis/features/auth/session.dart';
import 'package:bothesis/features/chat/models/chat_models.dart';
import 'package:bothesis/features/chat/services/chat_service.dart';
import 'package:bothesis/features/chat/services/conversation_store.dart';
import 'package:bothesis/features/chat/state/chat_controller.dart';
import 'package:bothesis/features/chat/widgets/app_sidebar.dart';
import 'package:bothesis/features/knowledge/knowledge_page.dart';
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
  'permissions': ['knowledge.read', 'item.manage'],
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
                themeMode: ThemeMode.light,
                onCycleTheme: () {},
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

  testWidgets(
    'new collection is selectable while home refresh is still pending',
    (tester) async {
      final refresh = Completer<http.Response>();
      var homeRequests = 0;
      const collection = {
        'id': 'created',
        'title': 'New research',
        'description': '',
        'permissions': ['collection.read', 'collection.update'],
      };
      final api = ApiClient(
        client: MockClient((request) async {
          if (request.url.path.endsWith('/knowledge/home')) {
            if (++homeRequests > 1) return refresh.future;
            return http.Response(
              '{"collections":[],"recent_documents":[]}',
              200,
            );
          }
          if (request.method == 'POST')
            return http.Response(jsonEncode(collection), 201);
          return http.Response('{"items":[],"total":0}', 200);
        }),
      )..accessToken = 'token';
      await tester.pumpWidget(
        MaterialApp(
          home: KnowledgePage(
            api: api,
            session: session(),
            onAskDocument: (_, _) {},
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('New collection'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Collection name'),
        'New research',
      );
      await tester.tap(find.text('Create collection'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 350));
      expect(tester.takeException(), isNull);
      expect(find.text('New research'), findsWidgets);
      refresh.complete(
        http.Response(
          jsonEncode({
            'collections': [collection],
            'recent_documents': [],
          }),
          200,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('No documents yet'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
      api.close();
    },
  );
}
