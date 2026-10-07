import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/workspace_scope.dart';
import '../../core/api_client.dart';
import '../../ui/ui.dart';
import '../manage/ingestion/ingestion_page.dart';
import 'document_feed.dart';
import 'knowledge_models.dart';
import 'share_sheet.dart';
import 'upload_sheet.dart';

enum _Tab { documents, sources, access, settings }

/// Documents lead; management is scoped to this resource's permissions.
class CollectionPage extends StatefulWidget {
  const CollectionPage({super.key, required this.collection});
  final KnowledgeCollection collection;

  @override
  State<CollectionPage> createState() => _CollectionPageState();
}

class _CollectionPageState extends State<CollectionPage> {
  ApiClient? _api;
  late KnowledgeCollection _collection = widget.collection;
  DocumentFeed? _feed;
  List<KnowledgeCollection> _children = const [];
  _Tab _tab = _Tab.documents;
  String _query = '', _filter = '';
  Timer? _debounce;
  final Set<String> _retrying = {};
  bool _starting = false;
  Object? _metaError;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final api = WorkspaceScope.of(context).api;
    if (!identical(api, _api)) {
      _api = api;
      _resetFeed();
      _loadMeta();
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _feed?.dispose();
    super.dispose();
  }

  bool _allowed(String permission) => _collection.can(permission);
  bool get _canSources => WorkspaceScope.of(context).session.can('source.manage');
  String get _path => '/collections/${Uri.encodeComponent(_collection.id)}';

  void _resetFeed() {
    _feed?.dispose();
    _feed = DocumentFeed(_api!, collectionId: _collection.id,
        search: _query, processingFilter: _filter)..load();
  }

  Future<void> _loadMeta() async {
    try {
      final values = await Future.wait([
        _api!.get(_path),
        readAllPages(_api!, '/collections'),
      ]);
      if (!mounted) return;
      setState(() {
        _collection = KnowledgeCollection.fromJson(values[0] as JsonMap);
        _children = (values[1] as List<JsonMap>)
            .map(KnowledgeCollection.fromJson)
            .where((item) => item.parentId == _collection.id).toList();
        _metaError = null;
      });
    } catch (error) {
      if (mounted) setState(() => _metaError = error);
    }
  }

  Future<void> _refresh() async {
    await Future.wait([_feed!.load(quiet: true), _loadMeta()]);
  }

  Future<void> _upload() async {
    if (await showUploadSheet(context, into: _collection, onQueued: (runId) {
      if (mounted) _feed!.follow(runId);
    }) && mounted) {
      await _refresh();
    }
  }

  void _ask() {
    WorkspaceScope.of(context).askAboutCollection?.call(_collection.id, _collection.title);
  }

  Future<void> _retry(KnowledgeDocument document) async {
    if (!_retrying.add(document.id)) return;
    setState(() {});
    try {
      final run = await startProcessing(_api!, documentIds: [document.id]);
      if (!mounted) return;
      _feed!.follow(run);
      await _feed!.load(quiet: true);
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _retrying.remove(document.id));
    }
  }

  Future<void> _processPending() async {
    setState(() => _starting = true);
    try {
      final run = await startProcessing(_api!, collectionId: _collection.id);
      if (!mounted) return;
      _feed!.follow(run);
      await _feed!.load(quiet: true);
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  Future<void> _delete() async {
    final confirmed = await confirmAction(context,
      title: 'Delete “${_collection.title}”?',
      message: 'This knowledge base and its documents stop appearing in answers. There is no restore action.',
      confirmLabel: 'Delete knowledge base', destructive: true,
    );
    if (!confirmed || !mounted) return;
    try {
      await _api!.delete(_path);
      if (mounted) Navigator.pop(context);
    } catch (error) {
      if (mounted) showError(context, error);
    }
  }

  @override
  Widget build(BuildContext context) {
    final canUpload = _allowed('collection.update');
    final tabs = {
      _Tab.documents: 'Documents',
      if (_canSources) _Tab.sources: 'Sources',
      if (_allowed('collection.share')) _Tab.access: 'Access',
      if (canUpload || _allowed('collection.delete')) _Tab.settings: 'Settings',
    };
    final selected = tabs.containsKey(_tab) ? _tab : _Tab.documents;
    return Scaffold(
      appBar: AppHeader(title: _collection.title, actions: [
        IconButton(tooltip: 'Ask about this knowledge base',
          onPressed: _ask, icon: const Icon(Icons.auto_awesome_outlined)),
      ]),
      floatingActionButton: selected == _Tab.documents
          ? AppFab(icon: canUpload ? Icons.add_rounded : Icons.auto_awesome_rounded,
              label: canUpload ? 'Add' : 'Ask', onPressed: canUpload ? _upload : _ask)
          : null,
      body: Column(children: [
        if (tabs.length > 1)
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(children: [
              for (final entry in tabs.entries) ...[
                ChoiceChip(label: Text(entry.value), selected: selected == entry.key,
                  onSelected: (_) => setState(() => _tab = entry.key)),
                const SizedBox(width: 8),
              ],
            ]),
          ),
        Expanded(child: switch (selected) {
          _Tab.documents => _documents(),
          _Tab.sources => CollectionSources(collectionId: _collection.id),
          _Tab.access => Padding(padding: const EdgeInsets.all(16),
              child: CollectionAccessView(key: ValueKey(_collection.id), collection: _collection)),
          _Tab.settings => _CollectionSettings(
              key: ValueKey('${_collection.id}:${_collection.title}:${_collection.description}'),
              collection: _collection,
              onSave: (title, description) async {
                await _api!.patch(_path, body: {'title': title, 'description': description});
                if (mounted) await _loadMeta();
              },
              onDelete: _allowed('collection.delete') ? _delete : null,
            ),
        }),
      ]),
    );
  }

  Widget _documents() => RefreshIndicator(
    onRefresh: _refresh,
    child: ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: kPagePadding.copyWith(bottom: kFabClearance),
      children: [
        if (_metaError != null) InlineNotice(
          text: friendlyError(_metaError!), actionLabel: 'Retry', onAction: _loadMeta),
        if (_collection.description.isNotEmpty) ...[
          Text(_collection.description, style: TextStyle(color: context.colors.ink2)),
          const SizedBox(height: 12),
        ],
        AppSearchField(hint: 'Search ${_collection.title}', onChanged: (value) {
          _debounce?.cancel();
          _debounce = Timer(const Duration(milliseconds: 300), () {
            if (!mounted) return;
            setState(() { _query = value.trim(); _resetFeed(); });
          });
        }),
        const SizedBox(height: 8),
        SingleChildScrollView(scrollDirection: Axis.horizontal, child: Row(children: [
          for (final entry in const {'': 'All', 'attention': 'Needs attention',
              'failed': 'Failed', 'processing': 'Processing'}.entries) ...[
            ChoiceChip(label: Text(entry.value), selected: _filter == entry.key,
              onSelected: (_) => setState(() { _filter = entry.key; _resetFeed(); })),
            const SizedBox(width: 8),
          ],
        ])),
        if (_children.isNotEmpty) ...[
          const SectionLabel('Inside this knowledge base'),
          for (final child in _children) ListRow(
            title: child.title, leading: const Icon(Icons.folder_outlined),
            onTap: () async {
              await Navigator.push(context, MaterialPageRoute<void>(
                builder: (_) => CollectionPage(collection: child)));
              if (mounted) await _refresh();
            },
          ),
        ],
        ListenableBuilder(listenable: _feed!, builder: (context, _) => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_feed!.following || _feed!.documents.any((d) => d.processing.isProcessing))
              const InlineNotice(icon: Icons.autorenew_rounded,
                text: 'Processing documents. You can leave this screen; server processing continues.'),
            if (_allowed('ingestion.run') && _feed!.documents.any((d) =>
                d.isProcessable && d.processing.awaitsRun))
              InlineNotice(text: 'Some documents are not searchable yet.',
                actionLabel: 'Process pending', onAction: _starting ? null : _processPending),
            SectionLabel('Documents', aside: _feed!.loading ? null : groupedNumber(_feed!.total)),
          ],
        )),
        DocumentFeedView(feed: _feed!, retrying: _retrying,
          onRetryDocument: _allowed('ingestion.run') ? _retry : null,
          empty: EmptyView(icon: Icons.upload_file_outlined,
            title: _filter.isNotEmpty || _query.isNotEmpty ? 'No matching documents' : 'No documents yet',
            message: _allowed('collection.update')
                ? 'Add files to this knowledge base. They become searchable after processing.'
                : 'Documents shared in this knowledge base appear here.'),
        ),
      ],
    ),
  );
}

class _CollectionSettings extends StatefulWidget {
  const _CollectionSettings({super.key, required this.collection, required this.onSave, this.onDelete});
  final KnowledgeCollection collection;
  final Future<void> Function(String title, String description) onSave;
  final Future<void> Function()? onDelete;
  @override
  State<_CollectionSettings> createState() => _CollectionSettingsState();
}

class _CollectionSettingsState extends State<_CollectionSettings> {
  late final _title = TextEditingController(text: widget.collection.title);
  late final _description = TextEditingController(text: widget.collection.description);
  bool _saving = false;
  bool get _dirty => _title.text.trim() != widget.collection.title ||
      _description.text.trim() != widget.collection.description;

  @override
  void dispose() { _title.dispose(); _description.dispose(); super.dispose(); }

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      await widget.onSave(_title.text.trim(), _description.text.trim());
      if (mounted) showToast(context, 'Changes saved');
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListView(padding: kPagePadding, children: [
    TextField(controller: _title, maxLength: 255,
      readOnly: !widget.collection.can('collection.update'),
      decoration: const InputDecoration(labelText: 'Name'),
      onChanged: (_) => setState(() {})),
    const SizedBox(height: 12),
    TextField(controller: _description, maxLength: 2000, minLines: 3, maxLines: 6,
      readOnly: !widget.collection.can('collection.update'),
      decoration: const InputDecoration(labelText: 'Description'),
      onChanged: (_) => setState(() {})),
    if (_dirty && widget.collection.can('collection.update'))
      FilledButton(onPressed: _saving || _title.text.trim().isEmpty ? null : _save,
        child: Text(_saving ? 'Saving…' : 'Save changes')),
    if (widget.onDelete != null) ...[
      const SectionLabel('Delete knowledge base'),
      const Text('Removes it and its documents from answers. No restore action is available.'),
      const SizedBox(height: 12),
      OutlinedButton(onPressed: _saving ? null : widget.onDelete,
        child: const Text('Delete knowledge base')),
    ],
  ]);
}
