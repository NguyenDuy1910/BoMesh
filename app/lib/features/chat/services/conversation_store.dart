import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/chat_models.dart';

class ConversationStore {
  ConversationStore({
    required String namespace,
    SharedPreferencesAsync? preferences,
  }) : _namespace = Uri.encodeComponent(namespace),
       _preferences = preferences ?? SharedPreferencesAsync() {
    if (namespace.isEmpty) throw ArgumentError.value(namespace, 'namespace');
  }

  final String _namespace;
  final SharedPreferencesAsync _preferences;
  static final Map<String, Future<void>> _pendingWrites = {};
  Future<void> get _writes =>
      _pendingWrites[_namespace] ?? Future<void>.value();
  set _writes(Future<void> value) => _pendingWrites[_namespace] = value;

  // Unscoped legacy caches are deliberately not imported into authenticated sessions.
  String get _conversationKey => 'bomesh-chat-v2:$_namespace:conversations';
  String _messageKey(String id) => 'bomesh-chat-v2:$_namespace:messages:$id';
  String get _selectionKey => 'bomesh-chat-v2:$_namespace:selected';

  Future<String?> selectedConversation() async {
    await _writes;
    return _preferences.getString(_selectionKey);
  }

  Future<void> selectConversation(String? id) =>
      _enqueue(() => _preferences.setString(_selectionKey, id ?? ''));

  Future<void> _enqueue(Future<void> Function() action) {
    final result = _writes.then((_) => action());
    _writes = result.catchError((Object _) {});
    return result;
  }

  Future<List<ChatConversation>> listConversations() async {
    await _writes;
    final values = await _readConversations();
    values.sort(
      (a, b) => a.pinned == b.pinned
          ? b.updatedAt.compareTo(a.updatedAt)
          : a.pinned
          ? -1
          : 1,
    );
    return values;
  }

  Future<List<ChatMessage>> getMessages(String id) async {
    await _writes;
    final raw = await _preferences.getString(_messageKey(id));
    if (raw == null) return [];
    final values = jsonDecode(raw);
    if (values is! List) {
      throw const FormatException('Saved conversation is invalid.');
    }
    return values.whereType<Map>().map((value) {
      final message = ChatMessage.fromJson(Map<String, dynamic>.from(value));
      if (message.turn?.status == 'streaming') {
        message.turn!
          ..status = 'failed'
          ..modelPending = false
          ..error = 'This response was interrupted. Retry to continue.';
      }
      return message;
    }).toList();
  }

  Future<void> saveConversation(
    String id,
    String title,
    List<ChatMessage> messages,
  ) {
    final encoded = jsonEncode(
      messages.map((message) => message.toJson()).toList(),
    );
    final now = DateTime.now();
    final files = {
      for (final message in messages) ...[
        ...message.documents.map((document) => 'document:${document.id}'),
        ...?message.turn?.artifacts.map(
          (artifact) => 'artifact:${artifact.id}',
        ),
      ],
    }.length;
    return _enqueue(() async {
      final values = await _readConversations();
      final index = values.indexWhere((value) => value.id == id);
      if (index < 0) {
        values.add(
          ChatConversation(
            id: id,
            title: title,
            createdAt: now,
            updatedAt: now,
            fileCount: files,
          ),
        );
      } else {
        values[index] = values[index].copyWith(
          updatedAt: now,
          fileCount: files,
        );
      }
      await _preferences.setString(_messageKey(id), encoded);
      await _writeConversations(values);
    });
  }

  Future<void> renameConversation(String id, String title) =>
      _enqueue(() async {
        final values = await _readConversations();
        final index = values.indexWhere((value) => value.id == id);
        if (index < 0) return;
        values[index] = values[index].copyWith(
          title: title,
          titleSource: 'custom',
        );
        await _writeConversations(values);
      });

  Future<void> pinConversation(String id, bool pinned) => _enqueue(() async {
    final values = await _readConversations();
    final index = values.indexWhere((value) => value.id == id);
    if (index < 0) return;
    values[index] = values[index].copyWith(pinned: pinned);
    await _writeConversations(values);
  });

  Future<void> deleteConversation(String id) => _enqueue(() async {
    final values = await _readConversations();
    values.removeWhere((value) => value.id == id);
    await _writeConversations(values);
    await _preferences.remove(_messageKey(id));
    if (await _preferences.getString(_selectionKey) == id) {
      await _preferences.setString(_selectionKey, '');
    }
  });

  Future<Set<String>> referencedDocumentIds({String? excluding}) async {
    final result = <String>{};
    for (final conversation in await listConversations()) {
      if (conversation.id == excluding) continue;
      final messages = await getMessages(conversation.id);
      result.addAll(
        messages
            .expand((message) => message.documents)
            .map((document) => document.id),
      );
      result.addAll(
        messages
            .expand(
              (message) => message.turn?.sources ?? const <AnswerSource>[],
            )
            .map((source) => source.itemId),
      );
    }
    return result;
  }

  Future<Set<String>> search(String query) async {
    final needle = query.toLowerCase().trim();
    final found = <String>{};
    for (final conversation in await listConversations()) {
      if (conversation.title.toLowerCase().contains(needle)) {
        found.add(conversation.id);
      } else {
        final messages = await getMessages(conversation.id);
        if (messages.any(
          (message) =>
              message.displayText.toLowerCase().contains(needle) ||
              message.documents.any(
                (document) => document.fileName.toLowerCase().contains(needle),
              ),
        )) {
          found.add(conversation.id);
        }
      }
    }
    return found;
  }

  Future<List<ChatConversation>> _readConversations() async {
    final raw = await _preferences.getString(_conversationKey);
    if (raw == null) return [];
    final values = jsonDecode(raw);
    if (values is! List) {
      throw const FormatException('Saved conversation history is invalid.');
    }
    return values
        .whereType<Map>()
        .map(
          (value) =>
              ChatConversation.fromJson(Map<String, dynamic>.from(value)),
        )
        .where((conversation) => conversation.deletedAt == null)
        .toList();
  }

  Future<void> _writeConversations(List<ChatConversation> values) =>
      _preferences.setString(
        _conversationKey,
        jsonEncode(values.map((value) => value.toJson()).toList()),
      );
}
