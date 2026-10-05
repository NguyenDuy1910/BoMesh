import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/account_sheet.dart';
import '../../app/workspace_scope.dart';
import '../../core/api_client.dart';
import '../../ui/ui.dart';
import 'collection_page.dart';
import 'document_feed.dart';
import 'knowledge_models.dart';
import 'knowledge_widgets.dart';
import 'upload_sheet.dart';

enum _View { mine, workspace }

/// The Library: your files, and the workspace's shared collections.
///
/// Search and the My files / Workspace switch lead. Each file wears its type
/// colour; only a file that can't be searched yet says so, in quiet text.
/// Upload is the one primary action. Creating, sharing and deleting
/// collections is management and lives in Manage → Knowledge.
class LibraryPage extends StatefulWidget {
  const LibraryPage({super.key});

  @override
  State<LibraryPage> createState() => _LibraryPageState();
}

class _LibraryPageState extends State<LibraryPage> {
  ApiClient? _api;
  _View _view = _View.mine;
  final _searchField = TextEditingController();
  Timer? _debounce;
  String _query = '';

  List<KnowledgeCollection> _collections = const [];
  String? _personalId;
  Object? _error;
  bool _loading = true;

  /// The documents shown: My files (optionally filtered), or the workspace
  /// search. Null while the view has nothing to list.
  DocumentFeed? _feed;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final api = WorkspaceScope.of(context).api;
    if (!identical(api, _api)) {
      _api = api;
      _loadHome();
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _searchField.dispose();
    _feed?.dispose();
    super.dispose();
  }

  Future<void> _loadHome({bool quiet = false}) async {
    if (!quiet && !_loading) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final value = await _api!.get('/knowledge/home');
      if (!mounted) return;
      final personal = textOf(value['personal_collection_id']);
      final personalId = personal.isEmpty ? null : personal;
      final changed = personalId != _personalId;
      setState(() {
        _collections = objectList(value['collections'])
            .map(KnowledgeCollection.fromJson)
            .toList();
        _personalId = personalId;
        _loading = false;
        _error = null;
      });
      final feed = _feed;
      if (!quiet || changed || feed == null) {
        _resetFeed();
      } else {
        await feed.load(quiet: true);
      }
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

  /// A fresh feed for what the view and search ask for.
  void _resetFeed() {
    _feed?.dispose();
    _feed = null;
    if (_view == _View.mine && _personalId != null) {
      _feed = DocumentFeed(_api!, collectionId: _personalId, search: _query)
        ..load();
    } else if (_view == _View.workspace && _query.isNotEmpty) {
      _feed = DocumentFeed(_api!, search: _query)..load();
    }
    setState(() {});
  }

  void _onSearch(String value) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () {
      if (!mounted || value.trim() == _query) return;
      _query = value.trim();
      _resetFeed();
    });
  }

  void _switch(_View view) {
    if (view == _view) return;
    _view = view;
    _resetFeed();
  }

  Future<void> _refresh() => _loadHome(quiet: true);

  Future<void> _upload() async {
    if (await showUploadSheet(context) && mounted) {
      // The first upload creates My files, so the home is read again.
      await _loadHome(quiet: true);
    }
  }

  Future<void> _open(KnowledgeCollection collection) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => CollectionPage(collection: collection),
      ),
    );
    if (mounted) await _loadHome(quiet: true);
  }

  @override
  Widget build(BuildContext context) {
    final mine = _view == _View.mine;
    return Scaffold(
      appBar: const AppHeader(title: 'Library', actions: [AccountButton()]),
      floatingActionButton: mine
          ? AppFab(
              icon: Icons.upload_rounded,
              label: 'Upload',
              onPressed: _upload,
            )
          : null,
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: kPagePadding.copyWith(bottom: mine ? kFabClearance : 28),
          children: [
            AppSearchField(
              controller: _searchField,
              hint: mine ? 'Search your files' : 'Search the workspace',
              onChanged: _onSearch,
            ),
            const SizedBox(height: 10),
            Segmented<_View>(
              segments: const {
                _View.mine: 'My files',
                _View.workspace: 'Workspace',
              },
              selected: _view,
              onChanged: _switch,
            ),
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
          title: 'The Library couldn’t be loaded',
          onRetry: _loadHome,
        ),
      ];
    }
    final feed = _feed;
    if (_view == _View.mine) {
      final empty = _query.isEmpty
          ? const EmptyView(
              icon: Icons.upload_file_outlined,
              title: 'No files yet',
              message: 'Upload a PDF, Word, Excel or text file to ask questions about it.',
            )
          : EmptyView(
              icon: Icons.search_off_rounded,
              title: 'No matches',
              message: 'None of your files match “$_query”.',
            );
      if (feed == null) return [const SizedBox(height: 8), empty];
      return [
        _countLabel(feed, _query.isEmpty ? 'Recent' : 'Matches'),
        DocumentFeedView(feed: feed, empty: empty),
      ];
    }
    if (feed != null) {
      return [
        _countLabel(feed, 'Matches'),
        DocumentFeedView(
          feed: feed,
          empty: EmptyView(
            icon: Icons.search_off_rounded,
            title: 'No matches',
            message: 'Nothing in the workspace matches “$_query”.',
          ),
        ),
      ];
    }
    final shared = topLevelOf(
      _collections.where((item) => item.id != _personalId).toList(),
    );
    if (shared.isEmpty) {
      return const [
        SizedBox(height: 8),
        EmptyView(
          icon: Icons.menu_book_outlined,
          title: 'No shared collections yet',
          message: 'Collections shared with you appear here.',
        ),
      ];
    }
    final childCounts = <String, int>{};
    for (final item in _collections) {
      if (item.parentId.isNotEmpty) {
        childCounts[item.parentId] = (childCounts[item.parentId] ?? 0) + 1;
      }
    }
    return [
      SectionLabel('Collections', aside: groupedNumber(shared.length)),
      for (final collection in shared) ...[
        CollectionCard(
          collection: collection,
          children: childCounts[collection.id],
          onTap: () => _open(collection),
        ),
        const SizedBox(height: 10),
      ],
    ];
  }

  Widget _countLabel(DocumentFeed feed, String title) => ListenableBuilder(
    listenable: feed,
    builder: (context, _) => SectionLabel(
      title,
      aside: feed.loading || feed.error != null || feed.documents.isEmpty
          ? null
          : countOf(feed.total, 'file'),
    ),
  );
}
