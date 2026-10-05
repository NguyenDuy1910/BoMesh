import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/workspace_scope.dart';
import '../../core/api_client.dart';
import '../../ui/ui.dart';
import '../auth/session.dart';
import 'collection_page.dart';
import 'document_feed.dart';
import 'knowledge_models.dart';
import 'knowledge_widgets.dart';
import 'upload_sheet.dart';

/// Manage → Knowledge: the workspace's knowledge as a library of collections.
///
/// Collections only — no document wall, no processing dashboard. One Add
/// button holds every way to add; sharing, renaming and deleting happen on
/// the collection itself.
class KnowledgeManagePage extends StatefulWidget {
  const KnowledgeManagePage({super.key});

  @override
  State<KnowledgeManagePage> createState() => _KnowledgeManagePageState();
}

class _KnowledgeManagePageState extends State<KnowledgeManagePage> {
  ApiClient? _api;
  late AuthSession _session;
  List<KnowledgeCollection> _collections = const [];
  Object? _error;
  bool _loading = true;
  Timer? _debounce;
  String _query = '';

  /// Documents matching the search, while there is one.
  DocumentFeed? _matches;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final scope = WorkspaceScope.of(context);
    _session = scope.session;
    if (!identical(scope.api, _api)) {
      _api = scope.api;
      _load();
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _matches?.dispose();
    super.dispose();
  }

  Future<void> _load({bool quiet = false}) async {
    if (!quiet && !_loading) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final home = await _api!.get('/knowledge/home');
      if (!mounted) return;
      setState(() {
        _collections = objectList(home['collections'])
            .map(KnowledgeCollection.fromJson)
            .toList();
        _loading = false;
        _error = null;
      });
      await _matches?.load(quiet: true);
    } catch (error) {
      if (!mounted) return;
      if (quiet && _error == null && !_loading) {
        showError(context, error);
        return;
      }
      setState(() {
        _error = error;
        _loading = false;
      });
    }
  }

  void _onSearch(String value) {
    setState(() => _query = value.trim());
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () {
      if (!mounted) return;
      _matches?.dispose();
      _matches = _query.isEmpty
          ? null
          : (DocumentFeed(_api!, search: _query)..load());
      setState(() {});
    });
  }

  Future<void> _open(KnowledgeCollection collection) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => CollectionPage(collection: collection),
      ),
    );
    if (mounted) await _load(quiet: true);
  }

  Future<void> _add() async {
    final canCreate = _session.can('knowledge.manage');
    final choice = await showAppSheet<String>(
      context,
      title: 'Add knowledge',
      subtitle: 'Choose one way to add to the workspace.',
      builder: (sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SheetOption(
            icon: Icons.upload_rounded,
            tone: Tone.violet,
            title: 'Upload files',
            subtitle: 'Into a collection you choose',
            onTap: () => Navigator.pop(sheetContext, 'upload'),
          ),
          if (canCreate)
            SheetOption(
              icon: Icons.create_new_folder_outlined,
              tone: Tone.indigo,
              title: 'New collection',
              subtitle: 'Name it and describe what it holds',
              onTap: () => Navigator.pop(sheetContext, 'collection'),
            ),
          SheetOption(
            icon: Icons.power_outlined,
            tone: Tone.sky,
            title: 'Connect a source',
            subtitle: 'Google Drive, Confluence — set up on the web',
            onTap: () => Navigator.pop(sheetContext, 'source'),
          ),
        ],
      ),
    );
    if (!mounted) return;
    switch (choice) {
      case 'upload':
        if (await showUploadSheet(context) && mounted) {
          await _load(quiet: true);
        }
      case 'collection':
        await _create();
      case 'source':
        showToast(context, 'Sources are connected on the web.');
    }
  }

  Future<void> _create() async {
    final values = await showCollectionForm(
      context,
      title: 'New collection',
      subtitle: 'Name it and describe what it holds.',
      confirmLabel: 'Create collection',
    );
    if (values == null || !mounted) return;
    try {
      final created = KnowledgeCollection.fromJson(
        await _api!.post(
          '/collections',
          body: {
            'title': values.title,
            if (values.description.isNotEmpty)
              'description': values.description,
          },
        ),
      );
      if (!mounted) return;
      await _open(created);
    } catch (error) {
      if (mounted) showError(context, error);
    }
  }

  @override
  Widget build(BuildContext context) {
    final total = _collections.fold<int>(
      0,
      (sum, collection) => sum + collection.documentCount,
    );
    return Scaffold(
      backgroundColor: context.colors.paper,
      appBar: AppHeader(
        paper: true,
        title: 'Knowledge',
        subtitle: _loading || _error != null
            ? null
            : '${countOf(_collections.length, 'collection')} · '
                  '${countOf(total, 'item')}',
      ),
      floatingActionButton: AppFab(
        icon: Icons.add_rounded,
        label: 'Add',
        onPressed: _add,
      ),
      body: RefreshIndicator(
        onRefresh: () => _load(quiet: true),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: kPagePadding.copyWith(bottom: kFabClearance),
          children: [
            AppSearchField(hint: 'Search knowledge…', onChanged: _onSearch),
            const SizedBox(height: 12),
            ..._content(),
          ],
        ),
      ),
    );
  }

  List<Widget> _content() {
    if (_loading) return const [LoadingView()];
    if (_error != null) {
      return [
        ErrorView(
          error: _error!,
          title: 'Knowledge couldn’t be loaded',
          onRetry: _load,
        ),
      ];
    }
    final childCounts = <String, int>{};
    for (final item in _collections) {
      if (item.parentId.isNotEmpty) {
        childCounts[item.parentId] = (childCounts[item.parentId] ?? 0) + 1;
      }
    }
    final needle = foldText(_query);
    final shown = needle.isEmpty
        ? topLevelOf(_collections)
        : _collections
              .where((item) => foldText(item.title).contains(needle))
              .toList();
    final matches = _matches;
    return [
      if (shown.isEmpty && needle.isEmpty)
        const EmptyView(
          icon: Icons.menu_book_outlined,
          title: 'No collections yet',
          message: 'Add one to start building the workspace’s knowledge.',
        ),
      if (needle.isNotEmpty)
        SectionLabel(
          'Collections',
          aside: groupedNumber(shown.length),
          first: true,
        ),
      if (shown.isEmpty && needle.isNotEmpty)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Text(
            'No collection is called that.',
            style: TextStyle(color: context.colors.ink3, fontSize: 13.5),
          ),
        ),
      for (final collection in shown) ...[
        CollectionCard(
          collection: collection,
          children: childCounts[collection.id],
          onTap: () => _open(collection),
        ),
        const SizedBox(height: 10),
      ],
      if (matches != null) ...[
        ListenableBuilder(
          listenable: matches,
          builder: (context, _) => SectionLabel(
            'Documents',
            aside: matches.loading || matches.documents.isEmpty
                ? null
                : groupedNumber(matches.total),
          ),
        ),
        DocumentFeedView(
          feed: matches,
          empty: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Text(
              'No document matches “$_query”.',
              style: TextStyle(color: context.colors.ink3, fontSize: 13.5),
            ),
          ),
        ),
      ],
    ];
  }
}
