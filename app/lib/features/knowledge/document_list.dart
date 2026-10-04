import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/app_theme.dart';
import '../../core/api_client.dart';
import 'document_page.dart';
import 'knowledge_models.dart';
import 'knowledge_widgets.dart';

typedef CollectionPermission = bool Function(String permission, String collectionId);

/// The documents of one collection, or every readable one when
/// [collectionId] is null, filtered by name.
///
/// One line of supporting text per row: the file type and date when the
/// document is ready, otherwise its processing state. Adding a document only
/// stores it; people who may run processing start it here, for the open
/// collection or one document. The list is re-read every few seconds only
/// while a document is processing or a run started here is still active.
class DocumentList extends StatefulWidget {
  const DocumentList({
    super.key,
    required this.api,
    required this.can,
    required this.onAskDocument,
    required this.empty,
    this.collectionId,
    this.search = '',
    this.personalCollectionId,
    this.bottomPadding = 96,
    this.watchRunId,
  });
  final ApiClient api;
  final CollectionPermission can;
  final void Function(String documentId, String title) onAskDocument;
  final Widget empty;
  final String? collectionId, personalCollectionId;
  final String search;

  /// Room under the last row for a floating action button.
  final double bottomPadding;

  /// A run started elsewhere (for example "Process now" after an upload)
  /// whose documents this list should follow until it finishes.
  final String? watchRunId;
  @override
  State<DocumentList> createState() => _DocumentListState();
}

class _DocumentListState extends State<DocumentList> {
  static const _pageSize = 30;
  List<KnowledgeDocument> _documents = [];
  int _total = 0, _request = 0;
  bool _loading = true, _more = false, _starting = false;
  String? _error;
  Timer? _poll;

  /// Runs started from this screen that are still queued or running. Their
  /// documents may read "Pending" until a batch picks them up, so the list
  /// keeps refreshing until the run itself finishes.
  final Set<String> _runs = {};

  @override
  void initState() {
    super.initState();
    if (widget.watchRunId?.isNotEmpty == true) _runs.add(widget.watchRunId!);
    _load();
  }

  @override
  void dispose() {
    _request++;
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load({bool more = false, bool quiet = false}) async {
    _poll?.cancel();
    final request = ++_request;
    if (!quiet) {
      setState(() {
        _loading = !more;
        _more = more;
        _error = null;
      });
    }
    // More continues from what is on screen; a quiet refresh re-reads all of
    // it in one request (up to the page limit) so rows update in place.
    final query = more
        ? {'page': _documents.length ~/ _pageSize + 1, 'page_size': _pageSize}
        : {
            'page': 1,
            'page_size': quiet && _documents.length > _pageSize
                ? (_documents.length > 100 ? 100 : _documents.length)
                : _pageSize,
          };
    try {
      final finished = <String>{};
      for (final run in _runs.toList()) {
        try {
          if (!await processingIsActive(widget.api, run)) finished.add(run);
        } catch (_) {
          // A run that cannot be read can no longer be followed; the
          // documents' own states still show where they stand.
          finished.add(run);
        }
      }
      final value = await widget.api.get(
        '/documents',
        query: {
          ...query,
          'collection_id': widget.collectionId,
          'search': widget.search,
        },
      );
      if (!mounted || request != _request) return;
      _runs.removeAll(finished);
      final documents = objectList(value['items']).map(KnowledgeDocument.fromJson).toList();
      setState(() {
        if (more) {
          final seen = {for (final document in _documents) document.id};
          _documents = [
            ..._documents,
            ...documents.where((document) => !seen.contains(document.id)),
          ];
        } else {
          _documents = documents;
        }
        _total = numberOf(value['total']);
        _loading = false;
        _more = false;
      });
      if (_runs.isNotEmpty ||
          _documents.any((document) => document.processing.isProcessing)) {
        _poll = Timer(const Duration(seconds: 5), () => _load(quiet: true));
      }
    } catch (error) {
      if (!mounted || request != _request) return;
      setState(() {
        _error = error.toString();
        _loading = false;
        _more = false;
      });
    }
  }

  bool _canEdit(KnowledgeDocument document) =>
      widget.can('collection.update', document.collectionId);

  bool _canDelete(KnowledgeDocument document) =>
      _canEdit(document) &&
      (document.purpose != 'conversation_attachment' ||
          document.collectionId == widget.personalCollectionId);

  bool _canAsk(KnowledgeDocument document) =>
      document.status == 'available' && !document.isArchive && !document.isImage;

  bool _canProcess(String collectionId) => widget.can('ingestion.run', collectionId);

  /// Failed documents are retried; pending and outdated ones processed.
  /// Ready, processing and unsupported documents offer nothing here.
  String? _processLabel(KnowledgeDocument document) {
    if (!document.isProcessable || !_canProcess(document.collectionId)) return null;
    return switch (document.processing.state) {
      'failed' => 'Retry processing',
      'pending' || 'outdated' => 'Process',
      _ => null,
    };
  }

  /// Pending or outdated documents of the open collection, as far as loaded.
  int get _awaiting => _documents
      .where((document) => document.isProcessable && document.processing.awaitsRun)
      .length;

  Future<void> _process({List<String>? documentIds, String? collectionId}) async {
    if (_starting) return;
    setState(() => _starting = true);
    try {
      final run = await startProcessing(
        widget.api,
        documentIds: documentIds,
        collectionId: collectionId,
      );
      if (!mounted) return;
      if (run.isNotEmpty) _runs.add(run);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Processing started')),
      );
      await _load(quiet: true);
    } catch (error) {
      // A 409 explains itself, e.g. the documents are already being processed.
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  Future<void> _open(KnowledgeDocument document) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (routeContext) => DocumentPage(
          api: widget.api,
          documentId: document.id,
          onAskDocument: (id, title) {
            Navigator.of(routeContext).pop();
            widget.onAskDocument(id, title);
          },
        ),
      ),
    );
    if (mounted) await _load(quiet: true);
  }

  Future<void> _actions(KnowledgeDocument document) async {
    final process = _processLabel(document);
    final action = await showModalBottomSheet<String>(
      context: context,
      useSafeArea: true,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
              child: Text(
                document.name,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            if (_canAsk(document))
              ListTile(
                leading: const Icon(Icons.chat_bubble_outline_rounded),
                title: const Text('Ask about this document'),
                onTap: () => Navigator.pop(sheetContext, 'ask'),
              ),
            if (process != null)
              ListTile(
                leading: const Icon(Icons.play_arrow_rounded),
                title: Text(process),
                onTap: () => Navigator.pop(sheetContext, 'process'),
              ),
            if (_canDelete(document))
              ListTile(
                leading: Icon(Icons.delete_outline_rounded, color: context.colors.danger),
                title: Text('Delete', style: TextStyle(color: context.colors.danger)),
                onTap: () => Navigator.pop(sheetContext, 'delete'),
              ),
          ],
        ),
      ),
    );
    if (!mounted) return;
    switch (action) {
      case 'ask':
        widget.onAskDocument(document.id, document.name);
      case 'process':
        await _process(documentIds: [document.id]);
      case 'delete':
        if (await confirmKnowledgeAction(
          context,
          title: 'Delete this document?',
          message: '“${document.name}” will no longer be used in answers. Past conversations are kept.',
          confirmLabel: 'Delete',
        )) {
          await _mutate(
            () => widget.api.delete('/documents/${Uri.encodeComponent(document.id)}'),
            'Document deleted',
          );
        }
    }
  }

  Future<void> _mutate(Future<Object?> Function() work, String done) async {
    try {
      await work();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(done)));
      await _load(quiet: true);
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    final collectionId = widget.collectionId;
    final awaiting = _awaiting;
    final offerProcess = collectionId != null &&
        widget.search.isEmpty &&
        _error == null &&
        _runs.isEmpty &&
        awaiting > 0 &&
        _canProcess(collectionId);
    return RefreshIndicator(
      onRefresh: () => _load(),
      child: NotificationListener<ScrollNotification>(
        onNotification: (notification) {
          if (!_more &&
              _documents.length < _total &&
              notification.metrics.extentAfter < 400) {
            _load(more: true);
          }
          return false;
        },
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: EdgeInsets.only(bottom: widget.bottomPadding),
          children: [
            if (_error != null)
              Padding(
                padding: const EdgeInsets.all(16),
                child: KnowledgeNotice(
                  title: 'Documents could not be loaded',
                  message: _error,
                  actionLabel: 'Try again',
                  onAction: _load,
                  danger: true,
                ),
              )
            else if (offerProcess)
              _ProcessBanner(
                text: _documents.length < _total
                    ? 'Some documents are not processed yet'
                    : awaiting == 1
                    ? '1 document is not processed yet'
                    : '$awaiting documents are not processed yet',
                busy: _starting,
                onProcess: () => _process(collectionId: collectionId),
              ),
            if (_error == null && _documents.isEmpty)
              widget.empty,
            for (final document in _documents)
              DocumentRow(
                document: document,
                onTap: () => _open(document),
                onMore: () => _actions(document),
              ),
            if (_more)
              const Padding(
                padding: EdgeInsets.all(16),
                child: Center(child: CircularProgressIndicator()),
              ),
          ],
        ),
      ),
    );
  }
}

/// One document: its name, and the one fact a person acts on.
class DocumentRow extends StatelessWidget {
  const DocumentRow({
    super.key,
    required this.document,
    required this.onTap,
    required this.onMore,
  });
  final KnowledgeDocument document;
  final VoidCallback onTap, onMore;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final kind = document.name.contains('.')
        ? document.name.split('.').last.toUpperCase()
        : 'File';
    final state = document.processing.state;
    final (String detail, Color tone) = document.isFailed
        ? (document.statusLabel, colors.danger)
        : document.status == 'pending_content'
        ? (document.statusLabel, colors.textSecondary)
        : state == 'processing'
        ? ('Processing…', colors.brand)
        : state == 'ready' || state == 'unsupported'
        ? ('$kind · ${readableDate(document.updatedAt)}', colors.textSecondary)
        : (document.statusLabel, colors.textSecondary);
    return ListTile(
      contentPadding: const EdgeInsets.fromLTRB(16, 2, 4, 2),
      onTap: onTap,
      leading: Container(
        width: 40,
        height: 40,
        decoration: BoxDecoration(
          color: colors.subtle,
          borderRadius: BorderRadius.circular(10),
        ),
        child: Icon(document.icon, color: colors.textSecondary, size: 20),
      ),
      title: Text(document.name, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(detail, style: TextStyle(color: tone)),
      trailing: IconButton(
        tooltip: 'More',
        onPressed: onMore,
        icon: const Icon(Icons.more_vert_rounded),
      ),
    );
  }
}

/// The open collection has documents that are not processed yet.
class _ProcessBanner extends StatelessWidget {
  const _ProcessBanner({
    required this.text,
    required this.busy,
    required this.onProcess,
  });
  final String text;
  final bool busy;
  final VoidCallback onProcess;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.fromLTRB(16, 4, 16, 8),
    padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
    decoration: BoxDecoration(
      color: context.colors.subtle,
      borderRadius: BorderRadius.circular(12),
    ),
    child: Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(text, style: Theme.of(context).textTheme.bodyMedium),
              Text(
                'They can be searched once processed.',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: context.colors.textSecondary,
                ),
              ),
            ],
          ),
        ),
        busy
            ? const Padding(
                padding: EdgeInsets.all(12),
                child: SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              )
            : TextButton(onPressed: onProcess, child: const Text('Process')),
      ],
    ),
  );
}
