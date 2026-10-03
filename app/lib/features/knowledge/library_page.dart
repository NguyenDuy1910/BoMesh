import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/app_theme.dart';
import '../../core/api_client.dart';
import '../auth/session.dart';
import 'document_list.dart';
import 'knowledge_models.dart';
import 'knowledge_widgets.dart';
import 'upload_sheet.dart';

enum _View { mine, workspace }

/// The Library: your files, and the workspace collections you can read.
///
/// One search, one switch between the two, and one Upload button that opens
/// the file picker straight away. Creating, sharing and deleting collections
/// is workspace administration and lives in the web console.
class LibraryPage extends StatefulWidget {
  const LibraryPage({
    super.key,
    required this.api,
    required this.session,
    required this.account,
    required this.onAskDocument,
  });
  final ApiClient api;
  final AuthSession session;
  final Widget account;
  final void Function(String documentId, String title) onAskDocument;
  @override
  State<LibraryPage> createState() => _LibraryPageState();
}

class _LibraryPageState extends State<LibraryPage> {
  final _search = TextEditingController();
  Timer? _debounce;
  _View _view = _View.mine;
  String _query = '';
  List<KnowledgeCollection> _collections = [];
  String? _personalId, _error;
  bool _loading = true, _uploading = false;
  int _revision = 0;

  @override
  void initState() {
    super.initState();
    _loadHome();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  Future<void> _loadHome() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final value = await widget.api.get('/knowledge/home');
      if (!mounted) return;
      final personal = textOf(value['personal_collection_id']);
      setState(() {
        _collections = objectList(value['collections'])
            .map(KnowledgeCollection.fromJson)
            .toList();
        _personalId = personal.isEmpty ? null : personal;
        _loading = false;
        _revision++;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.toString();
        _loading = false;
      });
    }
  }

  bool _can(String permission, String collectionId) =>
      widget.session.can(permission) ||
      _collections.any(
        (collection) => collection.id == collectionId && collection.can(permission),
      );

  void _onSearch(String value) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () {
      if (mounted) setState(() => _query = value.trim());
    });
  }

  /// Your own files always accept uploads; the collection is created the
  /// first time it is needed.
  Future<void> _uploadMine() async {
    if (_uploading) return;
    setState(() => _uploading = true);
    try {
      final personal = KnowledgeCollection.fromJson(
        await widget.api.put('/collections/personal'),
      );
      if (!mounted) return;
      _personalId = personal.id;
      final added = await uploadDocuments(
        context,
        api: widget.api,
        collection: personal,
        personal: true,
      );
      if (added && mounted) await _loadHome();
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  Future<void> _openCollection(KnowledgeCollection collection) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => _CollectionPage(
          api: widget.api,
          collection: collection,
          can: _can,
          onAskDocument: widget.onAskDocument,
        ),
      ),
    );
    if (mounted) await _loadHome();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final shared = _collections.where((collection) => collection.id != _personalId).toList();
    return Scaffold(
      backgroundColor: colors.appBackground,
      floatingActionButton: _view == _View.mine
          ? FloatingActionButton.extended(
              onPressed: _uploading ? null : _uploadMine,
              icon: _uploading
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.upload_rounded),
              label: const Text('Upload'),
            )
          : null,
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 8, 0),
              child: Row(
                children: [
                  Expanded(
                    child: Text('Library', style: Theme.of(context).textTheme.headlineSmall),
                  ),
                  widget.account,
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
              child: SearchBar(
                controller: _search,
                hintText: _view == _View.mine ? 'Search your files' : 'Search the workspace',
                leading: const Icon(Icons.search_rounded),
                elevation: const WidgetStatePropertyAll(0),
                trailing: [
                  if (_search.text.isNotEmpty)
                    IconButton(
                      tooltip: 'Clear search',
                      onPressed: () {
                        _search.clear();
                        _onSearch('');
                      },
                      icon: const Icon(Icons.close_rounded),
                    ),
                ],
                onChanged: _onSearch,
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: SizedBox(
                width: double.infinity,
                child: SegmentedButton<_View>(
                  showSelectedIcon: false,
                  segments: const [
                    ButtonSegment(value: _View.mine, label: Text('My files')),
                    ButtonSegment(value: _View.workspace, label: Text('Workspace')),
                  ],
                  selected: {_view},
                  onSelectionChanged: (value) => setState(() => _view = value.first),
                ),
              ),
            ),
            Expanded(child: _content(shared)),
          ],
        ),
      ),
    );
  }

  Widget _content(List<KnowledgeCollection> shared) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Padding(
        padding: const EdgeInsets.all(16),
        child: KnowledgeNotice(
          title: 'The library could not be loaded',
          message: _error,
          actionLabel: 'Try again',
          onAction: _loadHome,
          danger: true,
        ),
      );
    }
    if (_view == _View.mine) {
      final empty = _Empty(
        icon: Icons.upload_file_outlined,
        text: _query.isEmpty
            ? 'Upload a PDF, Word, Excel or text file to ask questions about it.'
            : 'No files match “$_query”.',
      );
      if (_personalId == null) return ListView(children: [empty]);
      return DocumentList(
        key: ValueKey('mine:$_personalId:$_query:$_revision'),
        api: widget.api,
        can: _can,
        collectionId: _personalId,
        personalCollectionId: _personalId,
        search: _query,
        onAskDocument: widget.onAskDocument,
        empty: empty,
      );
    }
    if (_query.isNotEmpty) {
      return DocumentList(
        key: ValueKey('workspace:$_query:$_revision'),
        api: widget.api,
        can: _can,
        personalCollectionId: _personalId,
        search: _query,
        onAskDocument: widget.onAskDocument,
        empty: _Empty(icon: Icons.search_off_rounded, text: 'No documents match “$_query”.'),
        bottomPadding: 24,
      );
    }
    return RefreshIndicator(
      onRefresh: _loadHome,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.only(bottom: 24),
        children: [
          if (shared.isEmpty)
            const _Empty(
              icon: Icons.folder_off_outlined,
              text: 'No shared collections yet. Collections shared with you appear here.',
            ),
          for (final collection in shared)
            ListTile(
              contentPadding: const EdgeInsets.fromLTRB(16, 2, 12, 2),
              leading: Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: context.colors.subtle,
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Icon(Icons.folder_outlined, color: context.colors.textSecondary, size: 20),
              ),
              title: Text(collection.title, maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: Text(
                collection.documentCount == 1 ? '1 document' : '${collection.documentCount} documents',
              ),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: () => _openCollection(collection),
            ),
        ],
      ),
    );
  }
}

/// One workspace collection's documents, with Upload when you may add to it.
class _CollectionPage extends StatefulWidget {
  const _CollectionPage({
    required this.api,
    required this.collection,
    required this.can,
    required this.onAskDocument,
  });
  final ApiClient api;
  final KnowledgeCollection collection;
  final CollectionPermission can;
  final void Function(String documentId, String title) onAskDocument;
  @override
  State<_CollectionPage> createState() => _CollectionPageState();
}

class _CollectionPageState extends State<_CollectionPage> {
  int _revision = 0;

  Future<void> _upload() async {
    final added = await uploadDocuments(
      context,
      api: widget.api,
      collection: widget.collection,
      personal: false,
    );
    if (added && mounted) setState(() => _revision++);
  }

  @override
  Widget build(BuildContext context) {
    final canUpload = widget.can('collection.update', widget.collection.id);
    return Scaffold(
      appBar: AppBar(title: Text(widget.collection.title)),
      floatingActionButton: canUpload
          ? FloatingActionButton.extended(
              onPressed: _upload,
              icon: const Icon(Icons.upload_rounded),
              label: const Text('Upload'),
            )
          : null,
      body: DocumentList(
        key: ValueKey('collection:${widget.collection.id}:$_revision'),
        api: widget.api,
        can: widget.can,
        collectionId: widget.collection.id,
        onAskDocument: (id, title) {
          Navigator.of(context).pop();
          widget.onAskDocument(id, title);
        },
        empty: const _Empty(icon: Icons.description_outlined, text: 'No documents in this collection yet.'),
        bottomPadding: canUpload ? 96 : 24,
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty({required this.icon, required this.text});
  final IconData icon;
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(32, 64, 32, 32),
    child: Column(
      children: [
        Icon(icon, size: 40, color: context.colors.textMuted),
        const SizedBox(height: 12),
        Text(
          text,
          textAlign: TextAlign.center,
          style: TextStyle(color: context.colors.textSecondary),
        ),
      ],
    ),
  );
}
