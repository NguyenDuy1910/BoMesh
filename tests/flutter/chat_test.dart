import 'dart:convert';

import 'package:bothesis/core/api_client.dart';
import 'package:bothesis/features/auth/session.dart';
import 'package:bothesis/features/chat/models/chat_models.dart';
import 'package:bothesis/features/chat/models/chat_stream.dart';
import 'package:bothesis/features/chat/services/chat_service.dart';
import 'package:bothesis/features/chat/services/conversation_store.dart';
import 'package:bothesis/features/chat/state/chat_controller.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences_platform_interface/in_memory_shared_preferences_async.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_async_platform_interface.dart';

AuthSession identity({String user = 'analyst', String workspace = 'team-a'}) =>
    AuthSession.fromJson({
  'access_token': 'token',
  'session_id': user,
  'user_id': user,
  'active_workspace_id': workspace,
  'expires_at': DateTime.now().add(const Duration(hours: 1)).toIso8601String(),
  'permissions': ['knowledge.read'],
  'platform_permissions': [],
  'workspaces': [
    {
      'id': workspace,
      'code': workspace,
      'name': workspace,
      'permissions': ['knowledge.read'],
    },
  ],
});

ChatMessage question({List<ConversationDocument> documents = const []}) =>
    ChatMessage(
      id: 'question',
      role: ChatRole.user,
      text: 'A confidential team question',
      documents: documents,
      createdAt: DateTime.now(),
    );

ConversationDocument document(String id, {String origin = 'upload'}) =>
    ConversationDocument(
      id: id,
      fileName: '$id.txt',
      contentType: 'text/plain',
      sizeBytes: 4,
      mode: 'indexed',
      status: 'available',
      origin: origin,
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    SharedPreferencesAsyncPlatform.instance =
        InMemorySharedPreferencesAsync.empty();
  });

  test(
    'saved conversation content cannot cross account or workspace boundaries',
    () async {
      final store = ConversationStore(namespace: identity().namespace);
      await store.saveConversation('confidential', 'Private', [question()]);
      final otherUser = ConversationStore(
        namespace: identity(user: 'other').namespace,
      );
      final otherWorkspace = ConversationStore(
        namespace: identity(workspace: 'team-b').namespace,
      );
      expect(await otherUser.getMessages('confidential'), isEmpty);
      expect(await otherWorkspace.listConversations(), isEmpty);
      expect(
        (await store.getMessages('confidential')).single.displayText,
        'A confidential team question',
      );
    },
  );

  test('process interruption restores partial answer as retryable, never still generating', () async {
    final store = ConversationStore(namespace: 'restore:team');
    final turn = ChatTurnState(id: 'turn');
    ChatStreamReducer.apply(
      turn,
      const ChatStreamEvent({
        'type': 'response.created',
        'response': {'id': 'response'},
      }),
    );
    ChatStreamReducer.apply(
      turn,
      const ChatStreamEvent({
        'type': 'response.output_text.delta',
        'item_id': 'answer',
        'output_index': 0,
        'content_index': 0,
        'delta': 'Partial answer',
      }),
    );
    await store.saveConversation('chat', 'Question', [
      question(),
      ChatMessage(
        id: 'answer',
        role: ChatRole.assistant,
        turn: turn,
        createdAt: DateTime.now(),
      ),
    ]);
    final restored = (await store.getMessages('chat')).last;
    expect(restored.displayText, 'Partial answer');
    expect(restored.turn!.status, 'failed');
    expect(restored.turn!.modelPending, isFalse);
  });

  test('completed tool response continues loop and duplicate deltas do not repeat text', () {
    final turn = ChatTurnState(id: 'turn');
    void event(Map<String, dynamic> value) =>
        ChatStreamReducer.apply(turn, ChatStreamEvent(value));
    event({
      'type': 'response.completed',
      'sequence_number': 1,
      'response': {
        'id': 'tool-response',
        'status': 'completed',
        'output': [
          {'id': 'call', 'type': 'function_call', 'name': 'knowledge_search'},
        ],
      },
    });
    expect(turn.status, 'streaming');
    event({
      'type': 'response.created',
      'sequence_number': 2,
      'response': {'id': 'answer-response'},
    });
    final delta = {
      'type': 'response.output_text.delta',
      'sequence_number': 3,
      'item_id': 'answer',
      'output_index': 0,
      'content_index': 0,
      'delta': 'Grounded answer',
    };
    event(delta);
    event(delta);
    event({
      'type': 'response.completed',
      'sequence_number': 4,
      'response': {
        'id': 'answer-response',
        'status': 'completed',
        'output': [
          {
            'id': 'answer',
            'type': 'message',
            'role': 'assistant',
            'content': [
              {'type': 'output_text', 'text': 'Grounded answer'},
            ],
          },
        ],
      },
    });
    expect(turn.finalAnswerText, 'Grounded answer');
    expect(turn.status, 'completed');
  });

  test('deleting chat releases only orphaned own uploads, never references or shared uploads', () async {
    final deleted = <String>[];
    final api = ApiClient(
      client: MockClient((request) async {
        if (request.method == 'DELETE') {
          deleted.add(request.url.path.split('/').last);
          return http.Response('', 204, request: request);
        }
        return http.Response(
          jsonEncode({'items': [], 'page': 1, 'page_size': 100, 'total': 0}),
          200,
          request: request,
        );
      }),
    )..accessToken = 'token';
    addTearDown(api.close);
    final store = ConversationStore(namespace: 'delete:team');
    await store.saveConversation('first', 'First', [
      question(
        documents: [
          document('orphan'),
          document('shared'),
          document('enterprise', origin: 'reference'),
        ],
      ),
    ]);
    await store.saveConversation('retained', 'Retained', [
      question(documents: [document('shared', origin: 'reference')]),
    ]);
    final controller = ChatController(ChatService(api), store, identity());
    addTearDown(controller.dispose);
    await controller.deleteConversation('first');
    expect(deleted, ['orphan']);
    expect((await store.listConversations()).single.id, 'retained');
  });

  test(
    'composer refuses oversized questions and eleventh attachment',
    () async {
      final api = ApiClient(
        client: MockClient(
          (request) async =>
              http.Response('{"items":[],"total":0}', 200, request: request),
        ),
      )..accessToken = 'token';
      addTearDown(api.close);
      final controller = ChatController(
        ChatService(api),
        ConversationStore(namespace: 'limits:team'),
        identity(),
      );
      addTearDown(controller.dispose);
      await controller.initialize();
      expect(controller.canSend('a' * 4000), isTrue);
      expect(controller.canSend('a' * 4001), isFalse);
      for (var index = 0; index < 11; index++) {
        controller.referenceDocument('doc-$index', 'Document $index');
      }
      expect(controller.attachments.length, 10);
      expect(
        controller.attachments.any((value) => value.document?.id == 'doc-10'),
        isFalse,
      );
    },
  );
}
