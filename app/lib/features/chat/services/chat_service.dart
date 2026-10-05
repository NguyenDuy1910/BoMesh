import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../../../core/api_client.dart';
import '../../../core/uploads.dart';
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
    final request = http.Request('POST', api.uri('/agent/chat'))
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

  /// Active collections the person can read; with [writable], only those
  /// they may add documents to.
  Future<List<ChatCollection>> listCollections({bool writable = false}) async {
    _checkSession();
    final items = await readAllPages(api, '/collections');
    _checkSession();
    return items
        .where((value) => value['status'] != 'archived')
        .where(
          (value) =>
              !writable ||
              (value['permissions'] is List &&
                  (value['permissions'] as List).contains('collection.update')),
        )
        .map(ChatCollection.fromJson)
        .toList();
  }

  /// One page of the documents the person can read, newest first, for
  /// choosing one to ask about. Files attached only to a chat are left out.
  Future<({List<JsonMap> items, int total})> listDocuments({
    String search = '',
    int page = 1,
    int pageSize = 40,
  }) async {
    _checkSession();
    final payload = await api.get(
      '/documents',
      query: {
        'page': page,
        'page_size': pageSize,
        'status': 'available',
        if (search.trim().isNotEmpty) 'search': search.trim(),
      },
    );
    _checkSession();
    return (
      items: objectList(payload['items'])
          .where((value) => value['purpose'] != 'conversation_attachment')
          .toList(),
      total: intOf(payload['total']),
    );
  }

  /// The cited passage, read through the permission-checked viewer.
  Future<String> citationPassage(String documentId, String chunkId) async {
    _checkSession();
    final payload = await api.get(
      '/knowledge/documents/${Uri.encodeComponent(documentId)}',
      query: {'chunk': chunkId},
    );
    _checkSession();
    return textOf(objectOf(payload['focus'])['chunk_text']).trim();
  }

  Future<ConversationDocument> uploadDocument(
    UploadFile file, {
    required void Function(UploadProgress progress) onProgress,
  }) async {
    _checkSession();
    onProgress(UploadProgress.starting);
    final personal = await api.put('/collections/personal');
    _checkSession();
    final id = textOf(personal['id']);
    if (id.isEmpty) {
      throw const ChatProtocolException(
        'Could not prepare your personal collection.',
      );
    }
    onProgress(UploadProgress.uploading);
    final result = await api.upload(
      '/collections/${Uri.encodeComponent(id)}/documents',
      file: file.source,
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
      fileName: textOf(document['name'], file.source.fileName),
      contentType: textOf(document['content_type'], file.source.contentType),
      sizeBytes:
          (document['size_bytes'] as num?)?.toInt() ?? file.source.length,
      mode: 'indexed',
      status: 'available',
      origin: 'upload',
    );
  }

  Future<void> releaseDocument(String documentId) async {
    _checkSession();
    try {
      await api.delete('/documents/${Uri.encodeComponent(documentId)}');
    } on ApiException catch (cause) {
      if (cause.status != 404) rethrow;
    }
  }

  Future<JsonMap> artifact(String id) {
    _checkSession();
    return api.get('/artifacts/${Uri.encodeComponent(id)}');
  }

  Future<JsonMap> artifactContent(String id, int revision) {
    _checkSession();
    return api.get(
      '/artifacts/${Uri.encodeComponent(id)}/revisions/$revision/content',
    );
  }

  /// A fresh signed link to one revision's file. Links are short-lived, so
  /// the detail is read again at the moment of download.
  Future<Uri> artifactDownload(String id, int revision) async {
    final detail = await artifact(id);
    _checkSession();
    final match = objectList(detail['revisions'])
        .where((value) => intOf(value['revision']) == revision)
        .firstOrNull;
    final url = textOf(
      match?['download_url'],
      intOf(detail['revision']) == revision
          ? textOf(detail['download_url'])
          : '',
    );
    final uri = Uri.tryParse(url);
    if (uri == null || !const ['https', 'http'].contains(uri.scheme)) {
      throw const ChatRequestException(
        'A download link is not available for this revision.',
      );
    }
    return uri;
  }

  /// Copies the artifact's latest revision into [collectionId].
  Future<JsonMap> publishArtifact(String id, String collectionId) {
    _checkSession();
    return api.post(
      '/artifacts/${Uri.encodeComponent(id)}/publish',
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

/// One attachment and the key that makes its upload safe to repeat.
class UploadFile {
  const UploadFile({required this.source, required this.idempotencyKey});
  final UploadSource source;
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
