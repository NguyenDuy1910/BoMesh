import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../../../core/api_client.dart';
import '../models/chat_models.dart';
import '../models/chat_stream.dart';

class ChatService {
  ChatService(this.api) : _sessionToken = api.accessToken;

  final ApiClient api;
  final String? _sessionToken;
  final Set<ChatStreamHandle> _streams = {};
  bool _closed = false;

  bool get isCurrentSession => !_closed && api.accessToken == _sessionToken;

  void _checkSession() {
    if (!isCurrentSession) {
      throw const ChatRequestException(
        'Your session changed. Reopen Chat to continue.',
      );
    }
  }

  ChatStreamHandle streamMessage({
    required String message,
    required String conversationId,
    required List<Map<String, String>> history,
    required List<String> attachmentIds,
    required List<String> collectionIds,
  }) {
    _checkSession();
    final requestClient = http.Client();
    final controller = StreamController<ChatStreamEvent>();
    var cancelled = false;
    late final ChatStreamHandle handle;
    void cancel() {
      if (cancelled) return;
      cancelled = true;
      requestClient.close();
      if (!controller.isClosed) unawaited(controller.close());
      _streams.remove(handle);
    }

    handle = ChatStreamHandle(events: controller.stream, cancel: cancel);
    _streams.add(handle);
    controller.onCancel = cancel;
    final request = http.Request('POST', api.uri('/api/v1/agent/chat'))
      ..headers.addAll({
        ...api.headers,
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json',
      })
      ..body = jsonEncode({
        'message': message,
        'conversation_id': conversationId,
        'history': history,
        'attachment_ids': attachmentIds,
        'collection_ids': collectionIds,
      });
    Future<void>(() async {
      try {
        if (cancelled) return;
        final response = await requestClient.send(request);
        if (cancelled || !isCurrentSession) return;
        if (response.statusCode < 200 || response.statusCode >= 300) {
          await api.decodeResponse(await http.Response.fromStream(response));
          throw const ChatRequestException('Chat request failed.');
        }
        if (!(response.headers['content-type'] ?? '').contains(
          'text/event-stream',
        )) {
          throw const ChatProtocolException(
            'Chat endpoint did not return an event stream.',
          );
        }
        final data = <String>[];
        void dispatch() {
          if (data.isEmpty || cancelled || !isCurrentSession) return;
          final value = data.join('\n');
          data.clear();
          if (value.trim() == '[DONE]') return;
          try {
            controller.add(ChatStreamEvent.decode(value));
          } on FormatException {
            throw const ChatProtocolException(
              'Received an invalid agent stream event.',
            );
          }
        }

        await for (final line
            in response.stream
                .transform(utf8.decoder)
                .transform(const LineSplitter())) {
          if (cancelled || !isCurrentSession) break;
          if (line.isEmpty) {
            dispatch();
          } else if (line.startsWith('data:')) {
            final value = line.substring(5);
            data.add(value.startsWith(' ') ? value.substring(1) : value);
          }
        }
        dispatch();
      } catch (cause, trace) {
        if (!cancelled && !controller.isClosed && isCurrentSession) {
          controller.addError(
            cause is http.ClientException
                ? const ChatRequestException(
                    'Connection interrupted. Check your network and retry the response.',
                  )
                : cause,
            trace,
          );
        }
      } finally {
        requestClient.close();
        _streams.remove(handle);
        if (!controller.isClosed) await controller.close();
      }
    });
    return handle;
  }

  Future<List<ChatCollection>> listCollections() async {
    _checkSession();
    final result = <ChatCollection>[];
    var page = 1;
    while (true) {
      final payload = await api.get(
        '/api/v1/collections',
        query: {'page': page, 'page_size': 100},
      );
      _checkSession();
      final items = objectList(payload['items']);
      result.addAll(
        items
            .where((value) => value['status'] != 'archived')
            .map(ChatCollection.fromJson),
      );
      if (items.isEmpty ||
          page * 100 >= (payload['total'] as num? ?? items.length)) {
        break;
      }
      page += 1;
    }
    return result;
  }

  Future<List<JsonMap>> searchDocuments(
    String query,
    List<String> collectionIds,
  ) async {
    _checkSession();
    final response = await api.post(
      '/api/v1/documents/search',
      body: {
        'query': query.trim(),
        'top_k': 20,
        'collection_ids': collectionIds,
      },
    );
    _checkSession();
    return objectList(response['items']);
  }

  Future<ConversationDocument> uploadDocument(
    UploadFile file, {
    required void Function(UploadProgress progress) onProgress,
  }) async {
    _checkSession();
    onProgress(UploadProgress.starting);
    final personal = await api.put('/api/v1/collections/personal');
    _checkSession();
    final id = textOf(personal['id']);
    if (id.isEmpty) {
      throw const ChatProtocolException(
        'Could not prepare your personal collection.',
      );
    }
    onProgress(UploadProgress.uploading);
    final result = await api.upload(
      '/api/v1/collections/${Uri.encodeComponent(id)}/documents',
      fileName: file.fileName,
      bytes: file.bytes,
      contentType: file.contentType,
      fields: const {'purpose': 'conversation_attachment'},
      idempotencyKey: file.idempotencyKey,
    );
    _checkSession();
    onProgress(UploadProgress.validating);
    final document = objectOf(result['document']);
    if (textOf(document['id']).isEmpty || document['status'] != 'available') {
      throw const ChatProtocolException(
        'The uploaded document is not available. Try uploading it again.',
      );
    }
    return ConversationDocument(
      id: textOf(document['id']),
      fileName: textOf(document['name'], file.fileName),
      contentType: textOf(document['content_type'], file.contentType),
      sizeBytes: (document['size_bytes'] as num?)?.toInt() ?? file.bytes.length,
      mode: 'indexed',
      status: 'available',
      origin: 'upload',
    );
  }

  Future<void> releaseDocument(String documentId) async {
    _checkSession();
    try {
      await api.delete('/api/v1/documents/${Uri.encodeComponent(documentId)}');
    } on ApiException catch (cause) {
      if (cause.status != 404) rethrow;
    }
  }

  Future<JsonMap> artifact(String id) {
    _checkSession();
    return api.get('/api/v1/artifacts/${Uri.encodeComponent(id)}');
  }

  Future<JsonMap> artifactContent(String id, int revision) {
    _checkSession();
    return api.get(
      '/api/v1/artifacts/${Uri.encodeComponent(id)}/revisions/$revision/content',
    );
  }

  Future<JsonMap> publishArtifact(String id, String collectionId) {
    _checkSession();
    return api.post(
      '/api/v1/artifacts/${Uri.encodeComponent(id)}/publish',
      body: {'collection_id': collectionId},
    );
  }

  void close() {
    _closed = true;
    for (final stream in _streams.toList()) {
      stream.cancel();
    }
  }
}

class ChatStreamHandle {
  const ChatStreamHandle({required this.events, required this.cancel});
  final Stream<ChatStreamEvent> events;
  final void Function() cancel;
}

enum UploadProgress { starting, uploading, validating, ready, failed }

class UploadFile {
  const UploadFile({
    required this.fileName,
    required this.contentType,
    required this.bytes,
    required this.idempotencyKey,
  });
  final String fileName;
  final String contentType;
  final Uint8List bytes;
  final String idempotencyKey;
}

class ChatRequestException implements Exception {
  const ChatRequestException(this.message);
  final String message;
  @override
  String toString() => message;
}

class ChatProtocolException extends ChatRequestException {
  const ChatProtocolException(super.message);
}
