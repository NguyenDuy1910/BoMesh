import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/workspace_scope.dart';
import '../../core/api_client.dart';
import '../../ui/ui.dart';
import '../chat/models/chat_models.dart';
import '../chat/services/conversation_store.dart';
import '../knowledge/collection_page.dart';
import '../knowledge/document_page.dart';
import '../knowledge/knowledge_models.dart';
import '../manage/access/member_page.dart';
import '../manage/access/access_page.dart';
import '../manage/activity_page.dart';
import '../manage/ingestion/ingestion_page.dart';
import '../manage/settings_page.dart';


class SearchPage extends StatefulWidget {
  const SearchPage({super.key});
  @override
  State<SearchPage> createState() => _SearchPageState();
}

class _SearchPageState extends State<SearchPage> {
  final _field = TextEditingController();
  Timer? _debounce;
  int _generation = 0;
  String _query = '';
  bool _loading = false;
  List<KnowledgeCollection> _collections = const [];
  List<JsonMap> _documents = const [], _people = const [];
  List<ChatConversation> _chats = const [];
  List<String> _errors = const [];
  final Set<String> _expanded = {};
  List<JsonMap> _passages = const [];
  bool _searchingPassages = false;

  @override
  void dispose() { _generation++; _debounce?.cancel(); _field.dispose(); super.dispose(); }

  void _changed(String value) {
    _debounce?.cancel();
    // Invalidate outstanding results immediately, not after the debounce.
    _generation++;
    _passages = const [];
    _searchingPassages = false;
    if (value.trim().isEmpty) {
      setState(() { _query = ''; _loading = false; _errors = []; });
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 300), () => _search(value.trim()));
  }

  Future<void> _search(String query) async {
    final request = ++_generation;
    final scope = WorkspaceScope.of(context);
    setState(() { _query = query; _loading = true; _errors = []; _expanded.clear(); });
    final errors = <String>[];
    Future<T?> section<T>(String label, Future<T> Function() read) async {
      try { return await read(); }
      catch (error) { errors.add('$label: $error'); return null; }
    }
    final collectionRead = section('Knowledge', () => readAllPages(scope.api, '/collections'));
    final documentRead = section('Documents', () => readAllPages(scope.api, '/documents', query: {'search': query}, limit: 100));
    final peopleRead = scope.session.can('user.manage')
        ? section('People', () => readAllPages(scope.api, '/users', query: {'search': query}, limit: 100))
        : Future<List<JsonMap>?>.value([]);
    final chatsRead = section('Chats on this device', () async {
      final store = ConversationStore(namespace: scope.session.namespace);
      final matches = await store.search(query);
      return (await store.listConversations()).where((chat) => matches.contains(chat.id)).toList();
    });
    final collections = await collectionRead;
    final documents = await documentRead;
    final people = await peopleRead;
    final chats = await chatsRead;
    if (!mounted || request != _generation) return;
    final needle = foldText(query);
    setState(() {
      _collections = (collections ?? []).map(KnowledgeCollection.fromJson).where((item) => foldText('${item.title} ${item.description}').contains(needle)).toList();
      _documents = documents ?? [];
      _people = (people ?? []).where((person) => foldText('${person['display_name']} ${person['email']}').contains(needle)).toList();
      _chats = chats ?? [];
      _errors = errors;
      _loading = false;
    });
  }

  Future<void> _searchPassages() async {
    final query = _field.text.trim();
    if (query.isEmpty || _searchingPassages) return;
    _debounce?.cancel();
    await _search(query);
    if (!mounted || _field.text.trim() != query) return;
    final generation = _generation;
    setState(() => _searchingPassages = true);
    try {
      final result = await WorkspaceScope.of(context).api.post('/documents/search',
        body: {'query': query, 'top_k': 20});
      if (!mounted || generation != _generation) return;
      setState(() => _passages = objectList(result['items']));
    } catch (error) {
      if (mounted && generation == _generation) {
        showError(context, error);
      }
    } finally {
      if (mounted && generation == _generation) setState(() => _searchingPassages = false);
    }
  }

  void _open(Widget page) => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page));

  List<Widget> _group(String title, List<Widget> rows) {
    if (rows.isEmpty) return [];
    return [SectionLabel(title, aside: '${rows.length}',
      actionLabel: rows.length > 3 ? (_expanded.contains(title) ? 'Show less' : 'See all') : null,
      onAction: () => setState(() { if (!_expanded.add(title)) _expanded.remove(title); })),
      ListGroup(children: _expanded.contains(title) ? rows : rows.take(3).toList())];
  }

  @override
  Widget build(BuildContext context) {
    final scope = WorkspaceScope.of(context);
    final pages = <String, Widget>{
      if (scope.manage.ingestion) 'Sources': const IngestionPage(),
      if (scope.manage.access) 'People & access': const AccessPage(),
      if (scope.manage.activity) 'Activity': const ActivityPage(),
      if (scope.manage.settings) 'Settings': const SettingsPage(),
    }.entries.where((entry) => foldText(entry.key).contains(foldText(_query))).toList();
    return Scaffold(
      backgroundColor: context.colors.paper,
      appBar: const AppHeader(title: 'Search', subtitle: 'Knowledge, documents, chats and people', paper: true),
      body: ListView(padding: kPagePadding, children: [
        AppSearchField(controller: _field, hint: 'Search your workspace', onChanged: _changed,
          onSubmitted: (_) => _searchPassages()),
        if (_query.isEmpty) const EmptyView(icon: Icons.search_rounded, title: 'Find your way back',
          message: 'Search document names, knowledge bases and chats saved on this device. Only content you can access is shown.')
        else ...[
          if (_loading) const LoadingView(label: 'Searching…')
          else ...[
            for (final error in _errors) Padding(padding: const EdgeInsets.only(top: 12),
              child: InlineNotice(text: error, tone: StatusTone.danger, actionLabel: 'Retry', onAction: () => _search(_query))),
            ..._group('Knowledge bases', [for (final item in _collections) ListRow(
              title: item.title, subtitle: item.description,
              leading: ToneTile(tone: toneFor(item.id), icon: Icons.menu_book_outlined, size: TileSize.small),
              onTap: () => _open(CollectionPage(collection: item)))]),
            ..._group('Matching passages', [for (final item in _passages) ListRow(
              title: textOf(item['name'], 'Document'),
              subtitle: textOf(item['excerpt']), maxSubtitleLines: 3,
              leading: Icon(Icons.format_quote_rounded, color: context.colors.evidence),
              onTap: () => _open(DocumentPage(
                documentId: textOf(item['document_id']),
                chunkId: objectOf(item['metadata'])['chunk_id'] as String?,
              )))]),
            ..._group('Documents', [for (final item in _documents) ListRow(
              title: textOf(item['name'], 'Document'),
              subtitle: 'Open document', leading: const ToneTile(tone: Tone.doc, icon: Icons.description_outlined, size: TileSize.small),
              onTap: () => _open(DocumentPage(documentId: textOf(item['id']))))]),
            ..._group('Chats on this device', [for (final chat in _chats) ListRow(
              title: chat.title, subtitle: relativeTime(chat.updatedAt),
              leading: const ToneTile(tone: Tone.indigo, icon: Icons.chat_bubble_outline_rounded, size: TileSize.small),
              onTap: () => scope.openConversation?.call(chat.id))]),
            ..._group('People', [for (final person in _people) ListRow(
              title: textOf(person['display_name'], textOf(person['email'], 'Member')), subtitle: textOf(person['email']),
              leading: PersonAvatar(name: textOf(person['display_name'], textOf(person['email'])), seed: textOf(person['id']), size: 32),
              onTap: () => _open(MemberPage(userId: textOf(person['id']))))]),
            ..._group('Pages', [
              for (final page in pages) ListRow(title: page.key,
                leading: const ToneTile(tone: Tone.slate, icon: Icons.grid_view_outlined, size: TileSize.small),
                onTap: () => _open(page.value)),
            ]),
            if (_collections.isEmpty && _documents.isEmpty && _passages.isEmpty && _chats.isEmpty && _people.isEmpty && pages.isEmpty && _errors.isEmpty && !_searchingPassages)
              EmptyView(icon: Icons.search_off_rounded, title: 'No matches for “$_query”', message: 'Try another name, or ask the assistant to search inside your documents.'),
          ],
          const SizedBox(height: 20),
          OutlinedButton.icon(
            onPressed: _searchingPassages ? null : _searchPassages,
            icon: const Icon(Icons.manage_search_rounded),
            label: Text(_searchingPassages ? 'Searching document contents…' : 'Search inside documents'),
          ),
          const SizedBox(height: 12),
          ListGroup(children: [ListRow(title: 'Ask about “$_query”', subtitle: 'Search inside the knowledge you can access',
            leading: const ToneTile(tone: Tone.indigo, icon: Icons.auto_awesome_outlined, size: TileSize.small),
            onTap: () => scope.askQuestion?.call(_query))]),
        ],
      ]),
    );
  }
}
