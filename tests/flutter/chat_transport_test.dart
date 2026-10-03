import 'dart:convert';
import 'dart:io';

import 'package:bothesis/core/api_client.dart';
import 'package:bothesis/features/chat/models/chat_models.dart';
import 'package:bothesis/features/chat/models/chat_stream.dart';
import 'package:bothesis/features/chat/services/chat_service.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'fragmented UTF-8 and multiline SSE reconstruct one completed answer',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      server.listen((request) async {
        await request.drain<void>();
        request.response.headers.contentType = ContentType(
          'text',
          'event-stream',
          charset: 'utf-8',
        );
        final events = [
          ': keepalive\r\n\r\n',
          'data: {"type":"response.created",\r\ndata: "response":{"id":"answer"},"sequence_number":1}\r\n\r\n',
          'data: {"type":"response.output_text.delta","item_id":"message","output_index":0,"content_index":0,"delta":"Xin chào","sequence_number":2}\n\n',
          'data: {"type":"response.completed","response":{"id":"answer","status":"completed","output":[{"id":"message","type":"message","role":"assistant","content":[{"type":"output_text","text":"Xin chào"}]}]},"sequence_number":3}\n\n',
          'data: [DONE]\n\n',
        ];
        for (final byte in utf8.encode(events.join())) {
          request.response.add([byte]);
          await request.response.flush();
        }
        await request.response.close();
      });
      final api = ApiClient(baseUrl: 'http://127.0.0.1:${server.port}')
        ..accessToken = 'session';
      final service = ChatService(api);
      addTearDown(service.close);
      addTearDown(api.close);
      final turn = ChatTurnState(id: 'turn');
      final handle = service.streamMessage(
        message: 'Hello',
        conversationId: newRequestId(),
        history: [],
        attachmentIds: [],
        collectionIds: [],
      );
      await for (final event in handle.events.timeout(
        const Duration(seconds: 10),
      )) {
        ChatStreamReducer.apply(turn, event);
      }
      expect(turn.finalAnswerText, 'Xin chào');
      expect(turn.status, 'completed');
    },
  );

  test(
    '401 from streaming endpoint expires authentication instead of hanging',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      server.listen((request) async {
        await request.drain<void>();
        request.response.statusCode = 401;
        request.response.write(
          '{"code":"SESSION_EXPIRED","message":"Session expired"}',
        );
        await request.response.close();
      });
      var expired = false;
      final api = ApiClient(baseUrl: 'http://127.0.0.1:${server.port}')
        ..accessToken = 'session'
        ..onUnauthorized = () => expired = true;
      final service = ChatService(api);
      addTearDown(service.close);
      addTearDown(api.close);
      final handle = service.streamMessage(
        message: 'Hello',
        conversationId: newRequestId(),
        history: [],
        attachmentIds: [],
        collectionIds: [],
      );
      await expectLater(
        handle.events.toList().timeout(const Duration(seconds: 10)),
        throwsA(isA<ApiException>()),
      );
      expect(expired, isTrue);
    },
  );
}
