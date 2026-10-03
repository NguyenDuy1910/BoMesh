import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/app_theme.dart';
import '../../core/api_client.dart';
import '../auth/session.dart';
import 'access_requests_page.dart';
import 'collection_access_page.dart';
import 'document_page.dart';
import 'knowledge_models.dart';
import 'knowledge_widgets.dart';
import 'upload_documents_dialog.dart';

class KnowledgePage extends StatefulWidget {
  const KnowledgePage({
    super.key,
    required this.api,
    required this.session,
    required this.onAskDocument,
  });
  final ApiClient api;
  final AuthSession session;
  final void Function(String documentId, String title) onAskDocument;
  @override
  State<KnowledgePage> createState() => _KnowledgePageState();
}

class _KnowledgePageState extends State<KnowledgePage> {
  List<KnowledgeCollection> _collections = [];
  List<KnowledgeDocument> _recent = [];
  List<KnowledgeDocument> _documents = [];
  List<KnowledgeSearchHit> _hits = [];
  String? _personalId;
  String _scope = 'home';
  String _searchMode = 'name';
  String _status = '';
  final _search = TextEditingController();
  bool _homeLoading = true;
  bool _loading = false;
  bool _more = false;
  bool _mutation = false;
  String? _homeError, _error;
  int _page = 1, _total = 0;
  int _request = 0, _homeRequest = 0;
  Timer? _debounce, _poll;

  bool get _current =>
      mounted && widget.api.accessToken == widget.session.accessToken;
  String? get _collectionId => _scope == 'personal'
      ? _personalId
      : _scope == 'home' || _scope == 'all'
      ? null
      : _scope;
  KnowledgeCollection? _collectionById(String? id) {
    for (final collection in _collections) {
      if (collection.id == id) return collection;
    }
    return null;
  }

  KnowledgeCollection? get _collection => _collectionById(_collectionId);
  bool _can(String permission, String? id) =>
      widget.session.can(permission) ||
      _collectionById(id)?.can(permission) == true;
  bool get _canUpload =>
      _scope == 'personal' && _personalId == null ||
      _can('collection.update', _collectionId);

  @override
  void initState() {
    super.initState();
    _loadHome();
  }

  @override
  void dispose() {
    _request++;
    _homeRequest++;
    _poll?.cancel();
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  Future<void> _loadHome() async {
    final request = ++_homeRequest;
    setState(() {
      _homeLoading = true;
      _homeError = null;
    });
    try {
      final value = await widget.api.get('/knowledge/home');
      if (!_current || request != _homeRequest) return;
      final personalId = textOf(value['personal_collection_id']);
      setState(() {
        _collections = objectList(value['collections'])
            .map(KnowledgeCollection.fromJson)
            .toList();
        _recent = objectList(value['recent_documents'])
            .map(KnowledgeDocument.fromJson)
            .toList();
        _personalId = personalId.isEmpty ? null : personalId;
        _homeLoading = false;
        if (_scope != 'home' &&
            _scope != 'all' &&
            _scope != 'personal' &&
            _collection == null) {
          _scope = 'home';
        }
      });
      if (_scope != 'home') await _loadDocuments();
    } catch (error) {
      if (!_current || request != _homeRequest) return;
      setState(() {
        _homeError = error.toString();
        _homeLoading = false;
      });
    }
  }

  Future<void> _loadDocuments({bool more = false, bool quiet = false}) async {
    _poll?.cancel();
    final request = ++_request;
    if (_scope == 'home') return;
    if (_scope == 'personal' && _personalId == null) {
      setState(() {
        _documents = [];
        _hits = [];
        _total = 0;
        _loading = false;
      });
      return;
    }
    final page = more
        ? _page + 1
        : quiet
        ? _page
        : 1;
    final collectionId = _collectionId;
    final search = _search.text.trim();
    final semantic = _searchMode == 'content';
    if (semantic && search.isEmpty) {
      setState(() {
        _hits = [];
        _documents = [];
        _total = 0;
        _loading = false;
      });
      return;
    }
    setState(() {
      _loading = !more && !quiet;
      _more = more;
      _error = null;
      if (!more && !quiet) {
        _documents = [];
        _hits = [];
      }
    });
    try {
      final value = semantic
          ? await widget.api.post(
              '/documents/search',
              body: {
                'query': search,
                'top_k': 20,
                if (collectionId != null) 'collection_ids': [collectionId],
              },
            )
          : await widget.api.get(
              '/documents',
              query: {
                'page': page,
                'page_size': 30,
                'collection_id': collectionId,
                'search': search,
                'status': _status,
              },
            );
      if (!_current || request != _request) return;
      setState(() {
        if (semantic) {
          _hits = objectList(value['items'])
              .map(KnowledgeSearchHit.fromJson)
              .toList();
        } else {
          final documents = objectList(value['items'])
              .map(KnowledgeDocument.fromJson)
              .toList();
          if (more) {
            final existing = _documents.map((document) => document.id).toSet();
            _documents = [
              ..._documents,
              ...documents.where((document) => !existing.contains(document.id)),
            ];
          } else if (quiet && page > 1) {
            final updated = {
              for (final document in documents) document.id: document,
            };
            _documents = _documents
                .map((document) => updated[document.id] ?? document)
                .toList();
          } else {
            _documents = documents;
          }
        }
        _page = page;
        _total = numberOf(value['total']);
        _loading = false;
        _more = false;
      });
      if (!semantic && _documents.any((document) => document.isActive)) {
        _poll = Timer(
          const Duration(seconds: 5),
          () => _loadDocuments(quiet: true),
        );
      }
    } catch (error) {
      if (!_current || request != _request) return;
      setState(() {
        _error = error.toString();
        _loading = false;
        _more = false;
      });
    }
  }

  void _changeScope(String value) {
    _debounce?.cancel();
    _poll?.cancel();
    _request++;
    setState(() {
      _scope = value;
      _search.clear();
      _searchMode = 'name';
      _status = '';
      _documents = [];
      _hits = [];
      _error = null;
      _total = 0;
    });
    if (value != 'home') _loadDocuments();
  }

  Future<void> _upload() async {
    if (!_canUpload || _mutation) return;
    KnowledgeCollection? destination = _collection;
    if (destination == null && _scope == 'personal') {
      setState(() => _mutation = true);
      try {
        destination = KnowledgeCollection.fromJson(
          await widget.api.put('/collections/personal'),
        );
        if (!_current) return;
        final created = destination;
        setState(() {
          _personalId = created.id;
          _collections = [
            ..._collections.where((collection) => collection.id != created.id),
            created,
          ];
        });
      } catch (error) {
        if (_current) setState(() => _error = error.toString());
      } finally {
        if (_current) setState(() => _mutation = false);
      }
    }
    if (!mounted || !_current || destination == null) return;
    final target = destination;
    final changed = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => UploadDocumentsDialog(
        api: widget.api,
        collection: target,
        personal: target.id == _personalId,
      ),
    );
    if (!_current) return;
    if (changed == true) await _loadHome();
  }

  Future<void> _editCollection([KnowledgeCollection? collection]) async {
    if (collection == null && !widget.session.can('item.manage')) return;
    if (collection != null && !_can('collection.update', collection.id)) return;
    final result = await showDialog<KnowledgeCollection>(
      context: context,
      builder: (context) => _CollectionEditor(
        api: widget.api,
        session: widget.session,
        collection: collection,
        parents: _collections
            .where(
              (collection) =>
                  collection.id != _personalId &&
                  collection.can('collection.update'),
            )
            .toList(),
      ),
    );
    if (!_current || result == null) return;
    setState(() {
      _collections = [
        ..._collections.where((collection) => collection.id != result.id),
        result,
      ];
      _scope = result.id == _personalId ? 'personal' : result.id;
      _search.clear();
      _searchMode = 'name';
      _status = '';
    });
    await _loadHome();
  }

  Future<void> _deleteCollection(KnowledgeCollection collection) async {
    if (!_can('collection.delete', collection.id)) return;
    final confirmed = await confirmKnowledgeAction(
      context,
      title: 'Delete collection?',
      message:
          '“${collection.title}” and access to its documents will be removed from normal use. This cannot be undone here.',
      confirmLabel: 'Delete collection',
    );
    if (!_current || !confirmed) return;
    setState(() {
      _mutation = true;
      _error = null;
    });
    try {
      await widget.api.delete(
        '/collections/${Uri.encodeComponent(collection.id)}',
      );
      if (!_current) return;
      _changeScope('home');
      await _loadHome();
    } catch (error) {
      if (_current) setState(() => _error = error.toString());
    } finally {
      if (_current) setState(() => _mutation = false);
    }
  }

  bool _canDeleteDocument(KnowledgeDocument document) =>
      _can('collection.update', document.collectionId) &&
      (document.purpose != 'conversation_attachment' ||
          document.collectionId == _personalId);

  Future<void> _deleteDocument(KnowledgeDocument document) async {
    if (!_canDeleteDocument(document)) return;
    final confirmed = await confirmKnowledgeAction(
      context,
      title: 'Delete document?',
      message:
          '“${document.name}” will be removed from this collection and will no longer be available for new answers. Existing conversations are not deleted.',
      confirmLabel: 'Delete document',
    );
    if (!_current || !confirmed) return;
    setState(() {
      _mutation = true;
      _error = null;
    });
    try {
      await widget.api.delete('/documents/${Uri.encodeComponent(document.id)}');
      if (!mounted || !_current) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Document deleted')));
      await _loadHome();
    } catch (error) {
      if (_current) setState(() => _error = error.toString());
    } finally {
      if (_current) setState(() => _mutation = false);
    }
  }

  Future<void> _retryIndexing(KnowledgeDocument document) async {
    if (!_can('collection.update', document.collectionId) ||
        document.ingestion?.canRetry != true) {
      return;
    }
    setState(() {
      _mutation = true;
      _error = null;
    });
    try {
      await widget.api.post(
        '/ingestions/${Uri.encodeComponent(document.ingestion!.id)}/retry',
      );
      if (!mounted || !_current) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Indexing retry started')));
      await _loadHome();
    } catch (error) {
      if (_current) setState(() => _error = error.toString());
    } finally {
      if (_current) setState(() => _mutation = false);
    }
  }

  Future<void> _openDocument(String id, {String? chunkId}) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (routeContext) => DocumentPage(
          api: widget.api,
          documentId: id,
          chunkId: chunkId,
          onAskDocument: (documentId, title) {
            Navigator.of(routeContext).pop();
            widget.onAskDocument(documentId, title);
          },
        ),
      ),
    );
    if (_current && _scope != 'home') await _loadDocuments();
  }

  Future<void> _sharing(KnowledgeCollection collection) async {
    if (!_can('collection.share', collection.id)) return;
    await Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (context) => CollectionAccessPage(
          api: widget.api,
          session: widget.session,
          collection: collection,
        ),
      ),
    );
    if (_current) await _loadHome();
  }

  @override
  Widget build(BuildContext context) {
    final collection = _collection;
    return Scaffold(
      backgroundColor: context.colors.appBackground,
      body: SafeArea(
        child: Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1080),
            child: RefreshIndicator(
              onRefresh: _loadHome,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 24, 16, 32),
                physics: const AlwaysScrollableScrollPhysics(),
                children: [
                  Text(
                    'YOUR KNOWLEDGE',
                    style: Theme.of(context).textTheme.labelMedium?.copyWith(
                      color: context.colors.brand,
                      letterSpacing: 1.6,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _scope == 'personal'
                        ? 'My library'
                        : collection?.title ?? 'Knowledge',
                    style: Theme.of(context).textTheme.headlineMedium,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _scope == 'personal'
                        ? 'Documents you upload and save from conversations.'
                        : collection?.description.isNotEmpty == true
                        ? collection!.description
                        : 'A shared home for sources, documents and grounded answers.',
                    style: TextStyle(
                      color: context.colors.textSecondary,
                      height: 1.5,
                    ),
                  ),
                  const SizedBox(height: 24),
                  DropdownButtonFormField<String>(
                    key: ValueKey('scope:$_scope:${_collections.length}'),
                    initialValue: _scope,
                    isExpanded: true,
                    decoration: const InputDecoration(
                      labelText: 'Browse',
                      prefixIcon: Icon(Icons.folder_outlined),
                    ),
                    items: [
                      const DropdownMenuItem(
                        value: 'home',
                        child: Text('Knowledge home'),
                      ),
                      const DropdownMenuItem(
                        value: 'personal',
                        child: Text('My library'),
                      ),
                      const DropdownMenuItem(
                        value: 'all',
                        child: Text('All accessible documents'),
                      ),
                      for (final collection in _collections.where(
                        (collection) => collection.id != _personalId,
                      ))
                        DropdownMenuItem(
                          value: collection.id,
                          child: Text(
                            collection.title,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                    ],
                    onChanged: _mutation
                        ? null
                        : (value) {
                            if (value != null) _changeScope(value);
                          },
                  ),
                  const SizedBox(height: 16),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      if (_canUpload && !_homeLoading)
                        FilledButton.icon(
                          onPressed: _mutation ? null : _upload,
                          icon: const Icon(Icons.upload_file_outlined),
                          label: const Text('Upload files'),
                        ),
                      if (widget.session.can('item.manage'))
                        OutlinedButton.icon(
                          onPressed: _mutation ? null : () => _editCollection(),
                          icon: const Icon(Icons.create_new_folder_outlined),
                          label: const Text('New collection'),
                        ),
                      OutlinedButton.icon(
                        onPressed: () => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            settings: const RouteSettings(
                              name: '/library/access-requests',
                            ),
                            builder: (_) => AccessRequestsPage(
                              api: widget.api,
                              session: widget.session,
                              collections: _collections,
                            ),
                          ),
                        ),
                        icon: const Icon(Icons.lock_open_outlined),
                        label: const Text('My access requests'),
                      ),
                      if (collection != null &&
                          collection.id != _personalId) ...[
                        if (_can('collection.update', collection.id))
                          OutlinedButton.icon(
                            onPressed: _mutation
                                ? null
                                : () => _editCollection(collection),
                            icon: const Icon(Icons.edit_outlined),
                            label: const Text('Edit'),
                          ),
                        if (_can('collection.share', collection.id))
                          OutlinedButton.icon(
                            onPressed: _mutation
                                ? null
                                : () => _sharing(collection),
                            icon: const Icon(Icons.group_outlined),
                            label: const Text('Access'),
                          ),
                        if (_can('collection.delete', collection.id))
                          IconButton(
                            tooltip: 'Delete collection',
                            onPressed: _mutation
                                ? null
                                : () => _deleteCollection(collection),
                            icon: Icon(
                              Icons.delete_outline,
                              color: context.colors.danger,
                            ),
                          ),
                      ],
                    ],
                  ),
                  if (_mutation)
                    const Padding(
                      padding: EdgeInsets.only(top: 16),
                      child: LinearProgressIndicator(),
                    ),
                  if (_homeError != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 16),
                      child: KnowledgeNotice(
                        title: 'Knowledge could not be loaded',
                        message: _homeError,
                        onAction: _loadHome,
                        danger: true,
                      ),
                    ),
                  if (_error != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 16),
                      child: KnowledgeNotice(
                        title: 'Action could not be completed',
                        message: _error,
                        onAction: () =>
                            _scope == 'home' ? _loadHome() : _loadDocuments(),
                        danger: true,
                      ),
                    ),
                  if (_homeLoading && _collections.isEmpty)
                    const Padding(
                      padding: EdgeInsets.all(48),
                      child: Center(
                        child: CircularProgressIndicator(
                          semanticsLabel: 'Loading knowledge',
                        ),
                      ),
                    )
                  else if (_scope == 'home')
                    ..._home()
                  else
                    ..._documentList(),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _home() => [
    const SizedBox(height: 24),
    Card(
      color: context.colors.brandSoft,
      child: InkWell(
        borderRadius: BorderRadius.circular(20),
        onTap: () => _changeScope('personal'),
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Row(
            children: [
              Icon(
                Icons.auto_stories_outlined,
                color: context.colors.brand,
                size: 32,
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Your personal library',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 4),
                    const Text('Uploads and documents saved from chat.'),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right),
            ],
          ),
        ),
      ),
    ),
    const SizedBox(height: 24),
    Text('Collections', style: Theme.of(context).textTheme.titleLarge),
    const SizedBox(height: 12),
    if (_collections
        .where((collection) => collection.id != _personalId)
        .isEmpty)
      const KnowledgeNotice(
        title: 'No shared collections yet',
        message: 'Collections you can access appear here. Ask a collection owner to share one with you.',
        icon: Icons.folder_open_outlined,
      ),
    for (final collection in _collections.where(
      (collection) => collection.id != _personalId,
    ))
      Card(
        margin: const EdgeInsets.only(bottom: 8),
        child: ListTile(
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 20,
            vertical: 10,
          ),
          leading: Icon(Icons.folder_outlined, color: context.colors.brand),
          title: Text(collection.title),
          subtitle: Text(
            '${collection.documentCount} documents · ${collection.sourceCount} sources',
          ),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => _changeScope(collection.id),
        ),
      ),
    const SizedBox(height: 24),
    Row(
      children: [
        Expanded(
          child: Text(
            'Recently updated',
            style: Theme.of(context).textTheme.titleLarge,
          ),
        ),
        TextButton(
          onPressed: () => _changeScope('all'),
          child: const Text('View all'),
        ),
      ],
    ),
    const SizedBox(height: 8),
    if (_recent.isEmpty)
      const KnowledgeNotice(
        title: 'Build your knowledge library',
        message: 'Upload a document to your library, then ask questions with the original source close at hand.',
        icon: Icons.description_outlined,
      ),
    for (final document in _recent) _documentCard(document),
  ];

  List<Widget> _documentList() => [
    const SizedBox(height: 24),
    TextField(
      controller: _search,
      maxLength: _searchMode == 'content' ? 512 : null,
      textInputAction: TextInputAction.search,
      decoration: InputDecoration(
        labelText: _searchMode == 'content'
            ? 'Search indexed content'
            : 'Search document names',
        prefixIcon: const Icon(Icons.search),
        suffixIcon: IconButton(
          tooltip: 'Clear search',
          onPressed: () {
            _search.clear();
            _loadDocuments();
          },
          icon: const Icon(Icons.close),
        ),
      ),
      onChanged: (_) {
        _debounce?.cancel();
        if (_searchMode == 'name') {
          _debounce = Timer(
            const Duration(milliseconds: 350),
            () => _loadDocuments(),
          );
        }
      },
      onSubmitted: (_) => _loadDocuments(),
    ),
    const SizedBox(height: 12),
    Wrap(
      spacing: 8,
      runSpacing: 8,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        ChoiceChip(
          label: const Text('By name'),
          selected: _searchMode == 'name',
          onSelected: (_) {
            setState(() => _searchMode = 'name');
            _loadDocuments();
          },
        ),
        if (widget.session.can('knowledge.read'))
          ChoiceChip(
            label: const Text('In content'),
            selected: _searchMode == 'content',
            onSelected: (_) {
              _debounce?.cancel();
              setState(() {
                _searchMode = 'content';
                _status = '';
              });
              _loadDocuments();
            },
          ),
        if (_searchMode == 'content')
          FilledButton(
            onPressed: _loading ? null : () => _loadDocuments(),
            child: const Text('Search'),
          ),
      ],
    ),
    if (_searchMode == 'name') ...[
      const SizedBox(height: 12),
      DropdownButtonFormField<String>(
        initialValue: _status,
        key: ValueKey('status:$_status'),
        isExpanded: true,
        decoration: const InputDecoration(labelText: 'Content availability'),
        items: const [
          DropdownMenuItem(value: '', child: Text('All content states')),
          DropdownMenuItem(value: 'available', child: Text('Available')),
          DropdownMenuItem(
            value: 'pending_content',
            child: Text('Awaiting content'),
          ),
          DropdownMenuItem(value: 'failed', child: Text('Content failed')),
        ],
        onChanged: (value) {
          setState(() => _status = value ?? '');
          _loadDocuments();
        },
      ),
    ],
    const SizedBox(height: 20),
    Text(
      _searchMode == 'content'
          ? 'Top matching passages · up to 20 results'
          : '$_total document${_total == 1 ? '' : 's'}',
      style: Theme.of(context).textTheme.labelLarge
          ?.copyWith(color: context.colors.textSecondary),
    ),
    const SizedBox(height: 12),
    if (_loading)
      const Padding(
        padding: EdgeInsets.all(32),
        child: Center(child: CircularProgressIndicator()),
      )
    else if (_searchMode == 'content') ...[
      if (_hits.isEmpty)
        KnowledgeNotice(
          title: _search.text.trim().isEmpty
              ? 'Search inside your sources'
              : 'No matching passages',
          message: _search.text.trim().isEmpty
              ? 'Enter a question or phrase. Only indexed documents you can access are searched.'
              : 'Try a different phrase, or search by file name to include documents still indexing.',
          icon: Icons.manage_search,
        ),
      for (final hit in _hits)
        Card(
          margin: const EdgeInsets.only(bottom: 12),
          child: InkWell(
            borderRadius: BorderRadius.circular(20),
            onTap: () => _openDocument(
              hit.documentId,
              chunkId: hit.chunkId.isEmpty ? null : hit.chunkId,
            ),
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    hit.name,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _collectionById(hit.collectionId)?.title ??
                        'Accessible collection',
                    style: TextStyle(color: context.colors.brand),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    hit.excerpt,
                    maxLines: 6,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(height: 1.5),
                  ),
                  const SizedBox(height: 12),
                  const Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      Text('Open source'),
                      SizedBox(width: 8),
                      Icon(Icons.arrow_forward, size: 18),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
    ] else ...[
      if (_documents.isEmpty)
        KnowledgeNotice(
          title: _search.text.isNotEmpty || _status.isNotEmpty
              ? 'No documents match'
              : 'No documents yet',
          message: _search.text.isNotEmpty || _status.isNotEmpty
              ? 'Try another name or clear the availability filter.'
              : _scope == 'personal'
              ? 'Upload a document, or save one from a conversation.'
              : 'Documents uploaded or synced into this collection will appear here.',
          icon: Icons.description_outlined,
        ),
      for (final document in _documents) _documentCard(document),
      if (_documents.length < _total)
        OutlinedButton(
          onPressed: _more ? null : () => _loadDocuments(more: true),
          child: Text(_more ? 'Loading…' : 'Load more documents'),
        ),
    ],
  ];

  Widget _documentCard(KnowledgeDocument document) => Card(
    margin: const EdgeInsets.only(bottom: 12),
    child: InkWell(
      borderRadius: BorderRadius.circular(20),
      onTap: () => _openDocument(document.id),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: context.colors.subtle,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Icon(document.icon, color: context.colors.brand),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        document.name,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      const SizedBox(height: 6),
                      Text(
                        '${readableBytes(document.size)} · ${readableDate(document.updatedAt)}',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                      if (_scope == 'all' || _scope == 'home')
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Text(
                            _collectionById(document.collectionId)?.title ??
                                'Collection',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: context.colors.textSecondary,
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
                PopupMenuButton<String>(
                  tooltip: 'Document actions',
                  onSelected: (action) {
                    switch (action) {
                      case 'ask':
                        widget.onAskDocument(document.id, document.name);
                      case 'retry':
                        _retryIndexing(document);
                      case 'delete':
                        _deleteDocument(document);
                      case 'open':
                        _openDocument(document.id);
                    }
                  },
                  itemBuilder: (context) => [
                    const PopupMenuItem(
                      value: 'open',
                      child: Text('Open document'),
                    ),
                    if (document.status == 'available' && !document.isArchive)
                      const PopupMenuItem(
                        value: 'ask',
                        child: Text('Ask document'),
                      ),
                    if (!_mutation &&
                        _can('collection.update', document.collectionId) &&
                        document.ingestion?.canRetry == true)
                      const PopupMenuItem(
                        value: 'retry',
                        child: Text('Retry indexing'),
                      ),
                    if (!_mutation && _canDeleteDocument(document))
                      const PopupMenuItem(
                        value: 'delete',
                        child: Text('Delete document'),
                      ),
                  ],
                ),
              ],
            ),
            const SizedBox(height: 12),
            DocumentStatusBadge(document: document),
            if (document.ingestion?.isActive == true)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: LinearProgressIndicator(
                  value: document.ingestion!.fraction,
                  semanticsLabel: document.ingestion!.label,
                ),
              ),
            if (document.ingestion?.error.isNotEmpty == true)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(
                  document.ingestion!.error,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: context.colors.danger),
                ),
              ),
          ],
        ),
      ),
    ),
  );
}

class _CollectionEditor extends StatefulWidget {
  const _CollectionEditor({
    required this.api,
    required this.session,
    required this.parents,
    this.collection,
  });
  final ApiClient api;
  final AuthSession session;
  final List<KnowledgeCollection> parents;
  final KnowledgeCollection? collection;
  @override
  State<_CollectionEditor> createState() => _CollectionEditorState();
}

class _CollectionEditorState extends State<_CollectionEditor> {
  final _form = GlobalKey<FormState>();
  late final _title = TextEditingController(
    text: widget.collection?.title ?? '',
  );
  late final _description = TextEditingController(
    text: widget.collection?.description ?? '',
  );
  String? _parent;
  bool _inherit = true;
  bool _busy = false;
  String? _error;
  @override
  void dispose() {
    _title.dispose();
    _description.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_form.currentState?.validate() != true || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final body = {
        'title': _title.text.trim(),
        'description': _description.text.trim().isEmpty
            ? null
            : _description.text.trim(),
        if (widget.collection == null) ...{
          'parent_collection_id': _parent,
          'inherit_access': _inherit,
        },
      };
      final result = widget.collection == null
          ? await widget.api.post('/collections', body: body)
          : await widget.api.patch(
              '/collections/${Uri.encodeComponent(widget.collection!.id)}',
              body: body,
            );
      if (!mounted || widget.api.accessToken != widget.session.accessToken) {
        return;
      }
      Navigator.pop(context, KnowledgeCollection.fromJson(result));
    } catch (error) {
      if (mounted) {
        setState(() {
          _error = error.toString();
          _busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !_busy,
    child: AlertDialog(
      scrollable: true,
      title: Text(
        widget.collection == null ? 'New collection' : 'Edit collection',
      ),
      content: SizedBox(
        width: 440,
        child: Form(
          key: _form,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextFormField(
                controller: _title,
                decoration: const InputDecoration(labelText: 'Collection name'),
                maxLength: 255,
                textCapitalization: TextCapitalization.sentences,
                validator: (value) => value?.trim().isNotEmpty == true
                    ? null
                    : 'Enter a collection name',
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _description,
                decoration: const InputDecoration(
                  labelText: 'Description (optional)',
                ),
                minLines: 3,
                maxLines: 5,
                maxLength: 2000,
              ),
              if (widget.collection == null && widget.parents.isNotEmpty) ...[
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: _parent ?? '',
                  isExpanded: true,
                  decoration: const InputDecoration(
                    labelText: 'Parent collection',
                  ),
                  items: [
                    const DropdownMenuItem(value: '', child: Text('No parent')),
                    for (final collection in widget.parents)
                      DropdownMenuItem(
                        value: collection.id,
                        child: Text(
                          collection.title,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                  ],
                  onChanged: _busy
                      ? null
                      : (value) => setState(
                          () => _parent = value?.isEmpty == true ? null : value,
                        ),
                ),
                if (_parent != null)
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Inherit parent access'),
                    subtitle: const Text(
                      'People who can access the parent can access this collection.',
                    ),
                    value: _inherit,
                    onChanged: _busy
                        ? null
                        : (value) => setState(() => _inherit = value),
                  ),
              ],
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 16),
                  child: KnowledgeNotice(
                    title: 'Collection could not be saved',
                    message: _error,
                    danger: true,
                  ),
                ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: Text(
            _busy
                ? 'Saving…'
                : widget.collection == null
                ? 'Create collection'
                : 'Save changes',
          ),
        ),
      ],
    ),
  );
}
