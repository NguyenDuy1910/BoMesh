import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../../core/api_client.dart';
import '../../../core/uploads.dart';
import '../../auth/session.dart';
import '../models/chat_models.dart';
import '../models/chat_stream.dart';
import '../services/chat_service.dart';
import '../services/conversation_store.dart';

class ChatController extends ChangeNotifier {
  ChatController(this.service, this._store, this.session)
    : _draftId = newRequestId();

  final ChatService service;
  final ConversationStore _store;
  final AuthSession session;
  ApiClient get api => service.api;

  List<ChatConversation> conversations = [];
  List<ChatMessage> messages = [];
  List<ChatCollection> collections = [];
  List<ComposerAttachment> attachments = [];
  Set<String> selectedCollectionIds = {};
  ChatStatus status = ChatStatus.ready;
  String? activeConversationId;
  String? error;
  String? collectionsError;
  bool isLoading = true;
  bool collectionsLoading = false;
  String draftText = '';
  int draftRevision = 0;

  String _draftId;
  ChatStreamHandle? _activeHandle;
  ChatTurnState? _activeTurn;
  int _runToken = 0;
  int _viewToken = 0;
  bool _disposed = false;
  Timer? _saveTimer;
  final Set<String> _deletingConversations = {};

  bool get isConfigured =>
      service.isCurrentSession && session.can('knowledge.read');
  bool get isGenerating => status != ChatStatus.ready;
  bool get isUploading => attachments.any(
    (value) =>
        value.progress != UploadProgress.ready &&
        value.progress != UploadProgress.failed,
  );
  String get conversationId => activeConversationId ?? _draftId;
  List<ChatCollection> get selectedCollections => collections
      .where((value) => selectedCollectionIds.contains(value.id))
      .toList();
  bool get hasUnavailableScope =>
      !collectionsLoading &&
      selectedCollectionIds.isNotEmpty &&
      selectedCollections.length != selectedCollectionIds.length;

  Future<void> initialize({
    String? documentId,
    String? documentTitle,
    String? collectionId,
    String? collectionTitle,
    String? prompt,
    String? conversationId,
  }) async {
    final view = ++_viewToken;
    try {
      final saved = await _store.listConversations();
      if (_disposed || view != _viewToken) return;
      conversations = saved;
      if (documentId == null && collectionId == null && prompt == null) {
        final selected = conversationId ?? await _store.selectedConversation();
        if (_disposed || view != _viewToken) return;
        // Only a conversation someone had open is reopened; otherwise Ask
        // starts on its home, with recent chats one tap away.
        activeConversationId = selected == null || selected.isEmpty
            ? null
            : saved.where((value) => value.id == selected).firstOrNull?.id;
        final restored = activeConversationId == null
            ? <ChatMessage>[]
            : await _store.getMessages(activeConversationId!);
        if (_disposed || view != _viewToken) return;
        messages = restored;
        _restoreCollections();
      } else {
        if (documentId != null) {
          referenceDocument(documentId, documentTitle ?? 'Document');
        }
        applyInitialDraft(
          collectionId: collectionId,
          collectionTitle: collectionTitle,
          prompt: prompt,
        );
      }
    } catch (cause) {
      if (!_disposed && view == _viewToken) error = cause.toString();
    } finally {
      if (!_disposed && view == _viewToken) {
        isLoading = false;
        _notify();
      }
    }
    if (isConfigured) unawaited(loadCollections());
  }

  void applyInitialDraft({
    String? collectionId,
    String? collectionTitle,
    String? prompt,
  }) {
    if (_disposed) return;
    if (collectionId != null) {
      selectedCollectionIds = {collectionId};
    }
    if (prompt != null) setDraft(prompt);
    if (collectionId != null && isConfigured) {
      unawaited(loadCollections());
    }
    _notify();
  }

  Future<void> loadCollections() async {
    if (_disposed || collectionsLoading) return;
    collectionsLoading = true;
    collectionsError = null;
    _notify();
    try {
      final values = await service.listCollections();
      if (_disposed) return;
      collections = values;
    } catch (cause) {
      if (!_disposed) collectionsError = cause.toString();
    } finally {
      if (!_disposed) {
        collectionsLoading = false;
        _notify();
      }
    }
  }

  Future<void> newChat() async {
    _cancelActive();
    ++_viewToken;
    _discardAttachments();
    activeConversationId = null;
    _draftId = newRequestId();
    messages = [];
    selectedCollectionIds = {};
    error = null;
    isLoading = false;
    setDraft('');
    _rememberSelection(null);
  }

  Future<void> selectConversation(String id) async {
    if (id == activeConversationId || _disposed) return;
    _cancelActive();
    _discardAttachments();
    final view = ++_viewToken;
    activeConversationId = id;
    _rememberSelection(id);
    messages = [];
    error = null;
    isLoading = true;
    setDraft('');
    try {
      final restored = await _store.getMessages(id);
      if (_disposed || view != _viewToken) return;
      messages = restored;
      _restoreCollections();
    } catch (cause) {
      if (!_disposed && view == _viewToken) error = cause.toString();
    } finally {
      if (!_disposed && view == _viewToken) {
        isLoading = false;
        _notify();
      }
    }
  }

  void _restoreCollections() {
    selectedCollectionIds =
        messages
            .where((message) => message.role == ChatRole.user)
            .lastOrNull
            ?.collections
            .map((collection) => collection.id)
            .toSet() ??
        {};
  }

  Future<void> renameConversation(String id, String title) async {
    final cleaned = title.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (cleaned.isEmpty || _disposed) return;
    await _localAction(() => _store.renameConversation(id, cleaned));
  }

  Future<void> pinConversation(ChatConversation conversation) => _localAction(
    () => _store.pinConversation(conversation.id, !conversation.pinned),
  );

  Future<void> _localAction(Future<void> Function() action) async {
    try {
      await action();
      final values = await _store.listConversations();
      if (_disposed) return;
      conversations = values;
    } catch (cause) {
      if (!_disposed) error = cause.toString();
    }
    _notify();
  }

  Future<Set<String>> searchConversations(String query) => _store.search(query);

  Future<void> deleteConversation(String id) async {
    if (_disposed || !_deletingConversations.add(id)) return;
    if (activeConversationId == id) _cancelActive();
    _notify();
    try {
      final removed = await _store.getMessages(id);
      final retainedIds = await _store.referencedDocumentIds(excluding: id);
      retainedIds.addAll(
        attachments
            .map((attachment) => attachment.document?.id)
            .whereType<String>(),
      );
      retainedIds.addAll(
        messages
            .where((message) => activeConversationId != id)
            .expand((message) => message.documents)
            .map((document) => document.id),
      );
      await _store.deleteConversation(id);
      final values = await _store.listConversations();
      if (_disposed) return;
      conversations = values;
      if (activeConversationId == id) await newChat();
      final owned = removed
          .expand((message) => message.documents)
          .where(
            (document) =>
                document.isUpload && !retainedIds.contains(document.id),
          )
          .map((document) => document.id)
          .toSet();
      for (final documentId in owned) {
        if (!service.isCurrentSession || _disposed) break;
        await service.releaseDocument(documentId);
      }
    } catch (cause) {
      if (!_disposed) {
        error = 'Could not finish deleting this conversation: $cause';
      }
    } finally {
      _deletingConversations.remove(id);
    }
    _notify();
  }

  void toggleCollection(String id) {
    if (isGenerating || _disposed) return;
    if (!selectedCollectionIds.remove(id)) {
      if (selectedCollectionIds.length >= 20) {
        error = 'Choose up to 20 collections for each question.';
      } else {
        selectedCollectionIds.add(id);
      }
    }
    _notify();
  }

  void clearCollections() {
    if (_disposed || isGenerating) return;
    selectedCollectionIds = {};
    _notify();
  }

  void rateAnswer(String id, bool helpful) {
    if (_disposed || isGenerating) return;
    messages = messages.map((message) {
      if (message.id != id || message.role != ChatRole.assistant) return message;
      return ChatMessage(
        id: message.id, role: message.role, text: message.text,
        documents: message.documents, collections: message.collections,
        turn: message.turn, createdAt: message.createdAt,
        rating: message.rating == helpful ? null : helpful,
      );
    }).toList();
    _persist();
    _notify();
  }

  bool canSend(String input) =>
      !_disposed &&
      !isLoading &&
      isConfigured &&
      !isGenerating &&
      !isUploading &&
      input.trim().length <= 4000 &&
      !_deletingConversations.contains(conversationId) &&
      (selectedCollectionIds.isEmpty ||
          (!collectionsLoading &&
              collectionsError == null &&
              selectedCollections.length == selectedCollectionIds.length)) &&
      !attachments.any(
        (attachment) => attachment.progress == UploadProgress.failed,
      ) &&
      (input.trim().isNotEmpty ||
          attachments.any((value) => value.document != null));

  void setDraft(String value) {
    draftText = value;
    draftRevision += 1;
    _notify();
  }

  void clearError() {
    if (error == null || _disposed) return;
    error = null;
    _notify();
  }

  void editArtifact(ChatArtifact artifact) =>
      setDraft('Update "${artifact.title}": ');

  void referenceDocument(String id, String title) {
    if (_disposed ||
        isGenerating ||
        attachments.any((value) => value.document?.id == id)) {
      return;
    }
    if (attachments.length >= 10) {
      error = 'Attach up to 10 documents to a question.';
      _notify();
      return;
    }
    attachments = [
      ...attachments,
      ComposerAttachment(
        key: 'reference:$id',
        fileName: title,
        sizeBytes: 0,
        progress: UploadProgress.ready,
        document: ConversationDocument(
          id: id,
          fileName: title,
          contentType: '',
          sizeBytes: 0,
          mode: 'indexed',
          status: 'available',
          origin: 'reference',
        ),
      ),
    ];
    _notify();
  }

  Future<void> addAttachment(UploadSource source) async {
    if (_disposed || isGenerating || attachments.length >= 10) return;
    final file = UploadFile(source: source, idempotencyKey: newRequestId());
    attachments = [
      ...attachments,
      ComposerAttachment(
        key: file.idempotencyKey,
        fileName: source.fileName,
        sizeBytes: source.length,
        progress: UploadProgress.starting,
        upload: file,
      ),
    ];
    _notify();
    await _upload(file);
  }

  Future<void> retryAttachment(String key) async {
    final value = attachments.where((item) => item.key == key).firstOrNull;
    if (value?.upload == null ||
        value?.progress != UploadProgress.failed ||
        _disposed) {
      return;
    }
    _updateAttachment(key, progress: UploadProgress.starting);
    await _upload(value!.upload!);
  }

  Future<void> _upload(UploadFile file) async {
    try {
      final document = await service.uploadDocument(
        file,
        onProgress: (progress) {
          if (!_disposed) {
            _updateAttachment(file.idempotencyKey, progress: progress);
          }
        },
      );
      if (_disposed) return;
      if (!attachments.any((item) => item.key == file.idempotencyKey)) {
        await _releaseUnused(document);
        return;
      }
      _updateAttachment(
        file.idempotencyKey,
        progress: UploadProgress.ready,
        document: document,
      );
    } catch (cause) {
      if (!_disposed) {
        _updateAttachment(
          file.idempotencyKey,
          progress: UploadProgress.failed,
          error: cause.toString(),
        );
      }
    }
  }

  void removeAttachment(String key) {
    final document = attachments
        .where((value) => value.key == key)
        .firstOrNull
        ?.document;
    attachments = attachments.where((value) => value.key != key).toList();
    if (document != null) unawaited(_releaseUnused(document));
    _notify();
  }

  void _discardAttachments() {
    final previous = attachments;
    attachments = [];
    for (final value in previous) {
      if (value.document != null) unawaited(_releaseUnused(value.document!));
    }
  }

  Future<void> _releaseUnused(ConversationDocument document) async {
    if (!document.isUpload || !service.isCurrentSession || _disposed) return;
    try {
      final referenced = await _store.referencedDocumentIds();
      if (!referenced.contains(document.id) &&
          !_disposed &&
          service.isCurrentSession) {
        await service.releaseDocument(document.id);
      }
    } catch (cause) {
      if (!_disposed) {
        error =
            'The attachment was removed from the question, but could not be deleted: $cause';
        _notify();
      }
    }
  }

  Future<void> sendMessage(String value) async {
    if (!canSend(value)) return;
    final documents = attachments
        .map((value) => value.document)
        .whereType<ConversationDocument>()
        .toList();
    final text = value.trim().isEmpty
        ? 'Please analyze the attached document.'
        : value.trim();
    attachments = [];
    await _run(
      text: text,
      includeUserMessage: true,
      historyMessages: List.of(messages),
      displayMessages: List.of(messages),
      documents: documents,
      scope: selectedCollections,
    );
  }

  Future<void> regenerate(String assistantId) async {
    if (isGenerating ||
        !isConfigured ||
        _disposed ||
        _deletingConversations.contains(conversationId)) {
      return;
    }
    final index = messages.indexWhere((message) => message.id == assistantId);
    if (index < 0) return;
    var userIndex = index - 1;
    while (userIndex >= 0 && messages[userIndex].role != ChatRole.user) {
      userIndex -= 1;
    }
    if (userIndex < 0) return;
    final user = messages[userIndex];
    await _run(
      text: user.text,
      includeUserMessage: false,
      historyMessages: messages.sublist(0, userIndex),
      displayMessages: messages.sublist(0, userIndex + 1),
      documents: user.documents,
      scope: user.collections,
    );
  }

  void stop() => _cancelActive();

  Future<void> _run({
    required String text,
    required bool includeUserMessage,
    required List<ChatMessage> historyMessages,
    required List<ChatMessage> displayMessages,
    required List<ConversationDocument> documents,
    required List<ChatCollection> scope,
  }) async {
    if (_activeHandle != null || _disposed) return;
    final token = ++_runToken;
    final id = conversationId;
    activeConversationId = id;
    error = null;
    status = ChatStatus.submitted;
    final turn = ChatTurnState(id: newRequestId());
    _activeTurn = turn;
    messages = [
      ...displayMessages,
      if (includeUserMessage)
        ChatMessage(
          id: newRequestId(),
          role: ChatRole.user,
          text: text,
          documents: documents,
          collections: scope,
          createdAt: DateTime.now(),
        ),
      ChatMessage(
        id: turn.id,
        role: ChatRole.assistant,
        turn: turn,
        createdAt: DateTime.now(),
      ),
    ];
    _persist();
    _notify();
    try {
      final handle = service.streamMessage(
        message: text,
        conversationId: id,
        history: _historyFromMessages(historyMessages),
        attachmentIds: documents.map((value) => value.id).toSet().toList(),
        collectionIds: scope.map((value) => value.id).toSet().toList(),
      );
      _activeHandle = handle;
      await for (final event in handle.events) {
        if (_disposed || token != _runToken) return;
        status = ChatStatus.streaming;
        ChatStreamReducer.apply(turn, event);
        if (turn.status == 'failed') error = turn.error;
        _saveTimer ??= Timer(const Duration(milliseconds: 700), () {
          _saveTimer = null;
          if (!_disposed && token == _runToken) _persist();
        });
        _notify();
      }
      if (_disposed || token != _runToken) return;
      if (turn.status == 'streaming') {
        turn
          ..status = 'failed'
          ..modelPending = false
          ..error = 'The connection ended before the response finished. Retry to continue.';
        error = turn.error;
      }
    } catch (cause) {
      if (_disposed || token != _runToken) return;
      turn
        ..status = 'failed'
        ..modelPending = false
        ..error = cause.toString();
      error = turn.error;
    } finally {
      if (!_disposed && token == _runToken) {
        _saveTimer?.cancel();
        _saveTimer = null;
        _activeHandle = null;
        _activeTurn = null;
        status = ChatStatus.ready;
        _persist();
        _notify();
      }
    }
  }

  void _cancelActive() {
    _runToken += 1;
    _saveTimer?.cancel();
    _saveTimer = null;
    _activeHandle?.cancel();
    _activeHandle = null;
    if (_activeTurn != null) {
      _activeTurn!
        ..status = 'failed'
        ..modelPending = false
        ..error = 'Response stopped. Retry to continue.';
      _activeTurn = null;
      _persist();
    }
    status = ChatStatus.ready;
    _notify();
  }

  void _rememberSelection(String? id) {
    unawaited(
      _store.selectConversation(id).catchError((Object cause) {
        if (!_disposed) {
          error = 'Could not remember the selected conversation: $cause';
          _notify();
        }
      }),
    );
  }

  void _persist() {
    final first = messages
        .where((value) => value.role == ChatRole.user)
        .firstOrNull;
    if (first == null) return;
    final id = conversationId;
    final title = _titleFromMessage(first.text);
    _rememberSelection(id);
    unawaited(
      _store
          .saveConversation(id, title, messages)
          .then((_) async {
            final saved = await _store.listConversations();
            if (_disposed) return;
            conversations = saved;
            _notify();
          })
          .catchError((Object cause) {
            if (!_disposed) {
              error = 'Could not save this conversation on your device: $cause';
              _notify();
            }
          }),
    );
  }

  void _updateAttachment(
    String key, {
    required UploadProgress progress,
    ConversationDocument? document,
    String? error,
  }) {
    if (_disposed) return;
    attachments = attachments
        .map(
          (value) => value.key != key
              ? value
              : ComposerAttachment(
                  key: key,
                  fileName: value.fileName,
                  sizeBytes: value.sizeBytes,
                  progress: progress,
                  document: document ?? value.document,
                  error: error,
                  upload: progress == UploadProgress.ready
                      ? null
                      : value.upload,
                ),
        )
        .toList();
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _cancelActive();
    service.close();
    super.dispose();
  }
}

class ComposerAttachment {
  const ComposerAttachment({
    required this.key,
    required this.fileName,
    required this.sizeBytes,
    required this.progress,
    this.document,
    this.error,
    this.upload,
  });
  final String key;
  final String fileName;
  final int sizeBytes;
  final UploadProgress progress;
  final ConversationDocument? document;
  final String? error;
  final UploadFile? upload;
}

List<Map<String, String>> _historyFromMessages(List<ChatMessage> messages) {
  var remaining = 24000;
  final selected = <Map<String, String>>[];
  for (final message in messages.reversed) {
    final content = _clipHistory(message.displayText.trim());
    if (content.isEmpty) continue;
    if (selected.length == 24 || content.length > remaining) break;
    selected.add({'role': message.role.name, 'content': content});
    remaining -= content.length;
  }
  final result = selected.reversed.toList();
  while (result.firstOrNull?['role'] == 'assistant') {
    result.removeAt(0);
  }
  return result;
}

String _clipHistory(String value) {
  const max = 8000;
  const marker = '\n…\n';
  if (value.length <= max) return value;
  final available = max - marker.length;
  final leading = (available * 0.6).ceil();
  return '${value.substring(0, leading)}$marker${value.substring(value.length - (available - leading))}';
}

String _titleFromMessage(String value) {
  final cleaned = value.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (cleaned.isEmpty) return 'New conversation';
  return cleaned.length > 54 ? '${cleaned.substring(0, 51)}…' : cleaned;
}
