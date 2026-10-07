import 'package:flutter/material.dart';

import '../../app/account_sheet.dart';
import '../../app/workspace_scope.dart';
import '../../core/api_client.dart';
import '../../ui/ui.dart';
import 'collection_page.dart';
import 'knowledge_models.dart';
import 'knowledge_widgets.dart';
import 'share_sheet.dart';

enum _Access { all, editable, readOnly, personal }

/// One permission-filtered home for personal and shared knowledge.
class LibraryPage extends StatefulWidget {
  const LibraryPage({super.key});

  @override
  State<LibraryPage> createState() => _LibraryPageState();
}

class _LibraryPageState extends State<LibraryPage> {
  ApiClient? _api;
  List<KnowledgeCollection> _collections = const [];
  String? _personalId;
  String _query = '';
  _Access _access = _Access.all;
  Object? _error;
  bool _loading = true;
  bool _openingPersonal = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final api = WorkspaceScope.of(context).api;
    if (!identical(api, _api)) {
      _api = api;
      _load();
    }
  }

  Future<void> _load({bool quiet = false}) async {
    if (!quiet) setState(() { _loading = true; _error = null; });
    final api = _api!;
    try {
      final home = await api.get('/knowledge/home');
      if (!mounted || !identical(api, _api)) return;
      setState(() {
        _collections = objectList(home['collections'])
            .map(KnowledgeCollection.fromJson).toList();
        _personalId = textOf(home['personal_collection_id']);
        _loading = false;
        _error = null;
      });
    } catch (error) {
      if (!mounted || !identical(api, _api)) return;
      if (quiet) { showError(context, error); return; }
      setState(() { _error = error; _loading = false; });
    }
  }

  Future<void> _open(KnowledgeCollection collection) async {
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => CollectionPage(collection: collection),
    ));
    if (mounted) await _load(quiet: true);
  }

  Future<void> _openPersonal() async {
    if (_openingPersonal) return;
    setState(() => _openingPersonal = true);
    try {
      final personal = _collections.where((c) => c.id == _personalId).firstOrNull;
      final collection = personal ?? KnowledgeCollection.fromJson(
        await _api!.put('/collections/personal'),
      );
      if (mounted) await _open(collection);
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _openingPersonal = false);
    }
  }

  Future<void> _create() async {
    final values = await showCollectionForm(
      context,
      title: 'Create knowledge base',
      subtitle: 'Group documents by team or topic. Share access after creating it.',
      confirmLabel: 'Create knowledge base',
    );
    if (values == null || !mounted) return;
    try {
      final collection = KnowledgeCollection.fromJson(await _api!.post(
        '/collections',
        body: {'title': values.title, 'description': values.description},
      ));
      if (mounted) await _open(collection);
    } catch (error) {
      if (mounted) showError(context, error);
    }
  }

  Future<void> _actions(KnowledgeCollection collection) async {
    final action = await showAppSheet<String>(
      context,
      title: collection.title,
      builder: (sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SheetOption(
            icon: Icons.auto_awesome_outlined,
            title: 'Ask about this knowledge base',
            onTap: () => Navigator.pop(sheetContext, 'ask'),
          ),
          if (collection.can('collection.share'))
            SheetOption(
              icon: Icons.person_add_alt_outlined,
              title: 'Share',
              onTap: () => Navigator.pop(sheetContext, 'share'),
            ),
        ],
      ),
    );
    if (!mounted) return;
    if (action == 'ask') {
      WorkspaceScope.of(context).askAboutCollection?.call(collection.id, collection.title);
    } else if (action == 'share') {
      await showShareSheet(context, collection);
      if (mounted) await _load(quiet: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scope = WorkspaceScope.of(context);
    final canCreate = scope.session.can('knowledge.manage');
    return Scaffold(
      backgroundColor: context.colors.paper,
      appBar: AppHeader(paper: true, actions: [
        IconButton(
          tooltip: 'Search',
          onPressed: scope.openSearch,
          icon: const Icon(Icons.search_rounded),
        ),
        const AccountButton(),
      ]),
      floatingActionButton: canCreate
          ? AppFab(icon: Icons.add_rounded, label: 'Create', onPressed: _create)
          : null,
      body: RefreshIndicator(
        onRefresh: () => _load(quiet: true),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: kPagePadding.copyWith(bottom: canCreate ? kFabClearance : 28),
          children: [
            Text('Knowledge', style: Theme.of(context).textTheme.headlineMedium),
            const SizedBox(height: 4),
            Text('Everything the assistant can answer from',
                style: TextStyle(color: context.colors.ink2)),
            const SizedBox(height: 16),
            AppSearchField(
              hint: 'Search knowledge bases',
              onChanged: (value) => setState(() => _query = foldText(value.trim())),
            ),
            const SizedBox(height: 10),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(children: [
                for (final entry in const {
                  _Access.all: 'All', _Access.editable: 'Can edit',
                  _Access.readOnly: 'View only', _Access.personal: 'Only you',
                }.entries) ...[
                  ChoiceChip(
                    label: Text(entry.value), selected: _access == entry.key,
                    onSelected: (_) => setState(() => _access = entry.key),
                  ),
                  const SizedBox(width: 8),
                ],
              ]),
            ),
            const SizedBox(height: 16),
            ..._content(),
          ],
        ),
      ),
    );
  }

  List<Widget> _content() {
    if (_loading) return const [LoadingView()];
    if (_error != null) return [ErrorView(error: _error!, onRetry: _load)];
    final showPersonal = (_access == _Access.all || _access == _Access.personal) &&
        (_query.isEmpty || foldText('My files').contains(_query));
    final shown = _collections.where((collection) {
      if (collection.id == _personalId || _access == _Access.personal) return false;
      if (_access == _Access.editable && !collection.can('collection.update')) return false;
      if (_access == _Access.readOnly && collection.can('collection.update')) return false;
      return foldText('${collection.title} ${collection.description}').contains(_query);
    }).toList();
    final personal = _collections.where((c) => c.id == _personalId).firstOrNull;
    return [
      if (showPersonal) ...[
        ListGroup(children: [ListRow(
          leading: const Icon(Icons.lock_outline_rounded),
          title: 'My files',
          subtitle: personal == null
              ? 'Only you · Upload files for your own chats'
              : 'Only you · ${countOf(personal.documentCount, 'document')}',
          onTap: _openingPersonal ? null : _openPersonal,
        )]),
        const SizedBox(height: 16),
      ],
      for (final collection in shown) ...[
        CollectionCard(
          collection: collection,
          onTap: () => _open(collection),
          onLongPress: () => _actions(collection),
        ),
        const SizedBox(height: 10),
      ],
      if (shown.isEmpty && _access != _Access.personal)
        EmptyView(
          icon: Icons.menu_book_outlined,
          title: _query.isEmpty ? 'No matching knowledge bases' : 'No matches',
          message: _query.isEmpty
              ? 'Knowledge bases you can access appear here. You can always add your own files to My files.'
              : 'Try another name or use Search to find documents and passages.',
        ),
    ];
  }
}
