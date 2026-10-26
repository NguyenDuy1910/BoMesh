import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/workspace_scope.dart';
import '../../core/api_client.dart';
import '../../ui/ui.dart';
import '../auth/session.dart';
import 'document_viewer.dart';
import 'knowledge_models.dart';

/// One document: its own preview first, then one big action to ask about it.
///
/// A file that is not searchable yet says so once, with the one fix. Rarer
/// actions (make searchable, download, delete) live in "···". The source is
/// always resolved afresh through the permission-checked viewer.
class DocumentPage extends StatefulWidget {
  const DocumentPage({
    super.key,
    required this.documentId,
    this.chunkId,
    this.offerAsk = true,
  });
  final String documentId;

  /// The cited passage to open at, from an answer's source.
  final String? chunkId;

  /// Whether "Ask about this document" is offered.
  final bool offerAsk;

  @override
  State<DocumentPage> createState() => _DocumentPageState();
}

enum _Stage { pages, text }

class _DocumentPageState extends State<DocumentPage> {
  ApiClient? _api;
  late AuthSession _session;
  KnowledgeViewer? _viewer;
  KnowledgeDocument? _document;
  KnowledgeCollection? _collection;
  Object? _error;
  bool _loading = true, _restricted = false, _starting = false;
  int _request = 0;
  Timer? _poll;
  _Stage? _stage;

  /// The run started here, followed until it finishes.
  String? _runId;

  DocumentRendition? _rendition;
  String? _renditionVersion;
  Object? _renditionError;
  final _firstCited = GlobalKey();

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
  void didUpdateWidget(covariant DocumentPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.documentId != widget.documentId ||
        oldWidget.chunkId != widget.chunkId) {
      _stage = null;
      _rendition = null;
      _renditionVersion = null;
      _load();
    }
  }

  @override
  void dispose() {
    _request++;
    _poll?.cancel();
    super.dispose();
  }

  ApiClient get _client => _api!;
  String get _path => Uri.encodeComponent(widget.documentId);

  Future<void> _load({bool quiet = false}) async {
    _poll?.cancel();
    final request = ++_request;
    if (!quiet) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      // A run that finished is noticed before the document is read again,
      // so the read shows where the run left it.
      var runId = _runId;
      if (runId != null) {
        try {
          if (!await processingIsActive(_client, runId)) runId = null;
        } catch (_) {
          runId = null;
        }
      }
      final values = await Future.wait([
        _client.get(
          '/knowledge/documents/$_path',
          query: {'chunk': widget.chunkId},
        ),
        _client.get('/documents/$_path'),
      ]);
      final viewer = KnowledgeViewer.fromJson(values[0]);
      final document = KnowledgeDocument.fromJson(values[1]);
      var collection = _collection?.id == document.collectionId
          ? _collection
          : null;
      if (collection == null && document.collectionId.isNotEmpty) {
        try {
          collection = KnowledgeCollection.fromJson(
            await _client.get(
              '/collections/${Uri.encodeComponent(document.collectionId)}',
            ),
          );
        } catch (_) {
          // Only its name and per-collection permissions come from here; the
          // workspace-wide permissions still apply.
        }
      }
      if (!mounted || request != _request) return;
      setState(() {
        _viewer = viewer;
        _document = document;
        _collection = collection;
        _runId = runId;
        _loading = false;
        _error = null;
        _restricted = false;
      });
      unawaited(_loadRendition(viewer));
      if (!quiet) _revealCited();
      if (document.processing.isProcessing || runId != null) {
        _poll = Timer(const Duration(seconds: 5), () => _load(quiet: true));
      }
    } catch (error) {
      if (!mounted || request != _request) return;
      final denied = error is ApiException && const [403, 404].contains(error.status);
      if (quiet && _viewer != null && !denied) {
        showError(context, error);
        return;
      }
      setState(() {
        _loading = false;
        _viewer = null;
        _document = null;
        _rendition = null;
        _renditionVersion = null;
        _restricted =
            error is ApiException && const [403, 404].contains(error.status);
        _error = error;
      });
    }
  }

  /// The whole-document rendition, read once per version.
  Future<void> _loadRendition(
    KnowledgeViewer viewer, {
    bool retry = false,
  }) async {
    if (viewer.renditionUrl.isEmpty) return;
    final version = viewer.renditionVersion;
    if (!retry && _renditionVersion == version) return;
    setState(() {
      _renditionVersion = version;
      _renditionError = null;
    });
    try {
      final rendition = await loadRendition(widget.documentId, viewer);
      if (!mounted || _renditionVersion != version) return;
      setState(() => _rendition = rendition);
      _revealCited();
    } catch (error) {
      if (!mounted || _renditionVersion != version) return;
      setState(() => _renditionError = error);
    }
  }

  /// Scroll to the cited part once it is on screen.
  void _revealCited() {
    if (widget.chunkId == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final target = _firstCited.currentContext;
      if (target != null && target.mounted) {
        Scrollable.ensureVisible(
          target,
          alignment: 0.15,
          duration: const Duration(milliseconds: 300),
        );
      }
    });
  }

  bool _allowed(String permission) =>
      allowedOn(_session, _collection, permission);

  bool get _becomingSearchable =>
      _runId != null || (_document?.processing.isProcessing ?? false);

  bool get _canMakeSearchable =>
      _document != null &&
      _document!.needsRun &&
      !_becomingSearchable &&
      _allowed('ingestion.run');

  Future<void> _makeSearchable() async {
    if (_starting) return;
    setState(() => _starting = true);
    try {
      final run = await startProcessing(
        _client,
        documentIds: [widget.documentId],
      );
      if (!mounted) return;
      _runId = run.isEmpty ? null : run;
      await _load(quiet: true);
    } catch (error) {
      // A 409 explains itself, e.g. it is already being made searchable.
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  /// Signed links are short-lived: re-read the viewer right before opening.
  Future<void> _openOriginal({bool external = false}) async {
    try {
      final viewer = KnowledgeViewer.fromJson(
        await _client.get(
          '/knowledge/documents/$_path',
          query: {'chunk': widget.chunkId},
        ),
      );
      final uri = Uri.tryParse(
        external ? viewer.externalUrl : viewer.originalUrl,
      );
      if (uri == null ||
          !const ['http', 'https'].contains(uri.scheme) ||
          uri.host.isEmpty) {
        throw const ApiException('There’s no safe link to this file.');
      }
      if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
        throw const ApiException('No app could open this file.');
      }
    } catch (error) {
      if (mounted) showError(context, error);
    }
  }

  Future<void> _delete() async {
    final document = _document!;
    final confirmed = await confirmAction(
      context,
      title: 'Delete “${document.name}”?',
      message: 'It stops appearing in answers. Past conversations keep what they said.',
      confirmLabel: 'Delete',
      destructive: true,
    );
    if (!confirmed || !mounted) return;
    try {
      await _client.delete('/documents/$_path');
      if (!mounted) return;
      showToast(context, 'Deleted');
      Navigator.of(context).pop();
    } catch (error) {
      if (mounted) showError(context, error);
    }
  }

  Future<void> _details() => showAppSheet<void>(
    context,
    title: 'Document details',
    builder: (_) {
      final document = _document!;
      return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(document.name, style: const TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 12),
          if (_collection != null) Text('Knowledge base: ${_collection!.title}'),
          Text('Type: ${FileKind.typeWord(contentType: document.contentType, name: document.name)}'),
          if (document.size > 0) Text('Size: ${readableBytes(document.size)}'),
          if (_viewer!.pageCount > 0) Text('Pages: ${_viewer!.pageCount}'),
          Text('Processing: ${sentenceCase(document.processing.state)}'),
          if (document.updatedAt.isNotEmpty) Text('Updated: ${relativeTime(document.updatedAt)}'),
          if (document.processing.error.isNotEmpty) Text(document.processing.error),
        ],
      );
    },
  );

  Future<void> _more() async {
    final viewer = _viewer!;
    final action = await showAppSheet<String>(
      context,
      builder: (sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SheetOption(
            icon: Icons.info_outline_rounded,
            title: 'Details',
            onTap: () => Navigator.pop(sheetContext, 'details'),
          ),
          if (_canMakeSearchable)
            SheetOption(
              icon: Icons.auto_awesome_rounded,
              tone: Tone.violet,
              title: 'Make searchable',
              subtitle: 'So the assistant can use it',
              onTap: () => Navigator.pop(sheetContext, 'searchable'),
            ),
          if (viewer.originalUrl.isNotEmpty)
            SheetOption(
              icon: Icons.download_rounded,
              title: 'Download',
              onTap: () => Navigator.pop(sheetContext, 'download'),
            ),
          if (viewer.externalUrl.isNotEmpty)
            SheetOption(
              icon: Icons.open_in_new_rounded,
              title: 'Open where it came from',
              subtitle: Uri.tryParse(viewer.externalUrl)?.host,
              onTap: () => Navigator.pop(sheetContext, 'source'),
            ),
          if (_allowed('collection.update'))
            SheetOption(
              icon: Icons.delete_outline_rounded,
              danger: true,
              title: 'Delete',
              subtitle: 'Stops appearing in answers',
              onTap: () => Navigator.pop(sheetContext, 'delete'),
            ),
        ],
      ),
    );
    if (!mounted) return;
    switch (action) {
      case 'details':
        await _details();
      case 'searchable':
        await _makeSearchable();
      case 'download':
        await _openOriginal();
      case 'source':
        await _openOriginal(external: true);
      case 'delete':
        await _delete();
    }
  }

  bool get _hasMore {
    final viewer = _viewer;
    if (viewer == null || _document == null) return false;
    return true;
  }

  @override
  Widget build(BuildContext context) {
    final viewer = _viewer;
    final document = _document;
    final ask =
        widget.offerAsk &&
        viewer != null &&
        (document?.askable ?? viewer.status == 'available');
    return Scaffold(
      appBar: AppHeader(
        actions: [
          if (viewer != null && viewer.originalUrl.isNotEmpty)
            IconButton(
              tooltip: 'Download',
              onPressed: _openOriginal,
              icon: const Icon(Icons.download_rounded),
            ),
          if (_hasMore)
            IconButton(
              tooltip: 'More',
              onPressed: _more,
              icon: const Icon(Icons.more_horiz_rounded),
            ),
        ],
      ),
      bottomNavigationBar: ask
          ? StickyActionBar(
              children: [
                Expanded(
                  child: FilledButton.icon(
                    onPressed: () =>
                        WorkspaceScope.of(context)
                            .askAboutDocument(widget.documentId, viewer.title),
                    icon: const Icon(Icons.auto_awesome_rounded, size: 18),
                    label: const Text('Ask about this document'),
                  ),
                ),
              ],
            )
          : null,
      body: _loading
          ? const LoadingView(label: 'Opening document')
          : _error != null
          ? _restricted
                ? const EmptyView(
                    icon: Icons.lock_outline_rounded,
                    title: 'This document isn’t available to you',
                    message:
                        'It may have been removed, or who can open it changed.',
                  )
                : ErrorView(
                    error: _error!,
                    title: 'This document couldn’t be opened',
                    onRetry: _load,
                  )
          : RefreshIndicator(
              onRefresh: () => _load(quiet: true),
              child: CustomScrollView(
                physics: const AlwaysScrollableScrollPhysics(),
                slivers: [
                  SliverPadding(
                    padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
                    sliver: SliverList.list(children: _header(viewer!)),
                  ),
                  SliverPadding(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 28),
                    sliver: _content(viewer),
                  ),
                ],
              ),
            ),
    );
  }

  List<Widget> _header(KnowledgeViewer viewer) {
    final colors = context.colors;
    final document = _document;
    final name = document?.name ?? viewer.title;
    final contentType = document?.contentType ?? viewer.contentType;
    final meta = [
      FileKind.typeWord(contentType: contentType, name: name),
      if ((document?.size ?? 0) > 0) readableBytes(document!.size),
      if (_collection != null) _collection!.title,
      if (document != null) relativeTime(document.updatedAt),
    ].where((part) => part.isNotEmpty).join(' · ');
    final notice = _notice();
    final pages = viewer.assets.isNotEmpty;
    final text = viewer.renditionUrl.isNotEmpty || viewer.elements.isNotEmpty;
    return [
      if (widget.chunkId?.isNotEmpty ?? false) ...[
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: colors.evidenceSoft,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Row(children: [
            Icon(Icons.format_quote_rounded, color: colors.evidence),
            const SizedBox(width: 8),
            const Expanded(child: Text('The passage cited in your answer')),
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Back'),
            ),
          ]),
        ),
        const SizedBox(height: 12),
      ],
      Padding(
        padding: const EdgeInsets.fromLTRB(4, 6, 4, 16),
        child: Row(
          children: [
            FileTile(
              contentType: contentType,
              name: name,
              size: TileSize.large,
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    name,
                    style: TextStyle(
                      color: colors.ink,
                      fontSize: 19,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.4,
                      height: 1.25,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    meta,
                    style: TextStyle(color: colors.ink3, fontSize: 13),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
      if (notice != null) ...[notice, const SizedBox(height: 12)],
      if (viewer.quote.isNotEmpty) ...[
        CitedPassage(text: viewer.quote, section: viewer.section),
        if (widget.offerAsk && WorkspaceScope.of(context).askQuestion != null)
          TextButton.icon(
            onPressed: () => WorkspaceScope.of(context).askQuestion?.call(
              'Explain this passage from “${viewer.title}”: ${viewer.quote}',
            ),
            icon: const Icon(Icons.auto_awesome_outlined, size: 18),
            label: const Text('Ask about this passage'),
          ),
        const SizedBox(height: 12),
      ] else if (widget.chunkId?.isNotEmpty ?? false) ...[
        const InlineNotice(text: 'The exact passage isn’t available any more.'),
        const SizedBox(height: 12),
      ],
      if (pages && text)
        Segmented<_Stage>(
          segments: const {_Stage.pages: 'Pages', _Stage.text: 'Text'},
          selected: _stage ?? _Stage.pages,
          onChanged: (stage) => setState(() => _stage = stage),
        ),
    ];
  }

  /// The one thing to know about whether the assistant can use it.
  Widget? _notice() {
    final document = _document;
    if (document == null) return null;
    final processing = document.processing;
    final canRun = _allowed('ingestion.run') && document.isProcessable;
    if (_becomingSearchable) {
      return const InlineNotice(
        icon: Icons.autorenew_rounded,
        text:
            'Becoming searchable. The assistant can use it once this finishes.',
      );
    }
    if (processing.isFailed) {
      return InlineNotice(
        tone: StatusTone.danger,
        icon: Icons.error_outline_rounded,
        text: processing.error.isEmpty
            ? 'It couldn’t be made searchable.'
            : 'It couldn’t be made searchable: ${processing.error}',
        actionLabel: canRun ? 'Try again' : null,
        onAction: canRun && !_starting ? _makeSearchable : null,
      );
    }
    if (processing.awaitsRun) {
      return InlineNotice(
        tone: StatusTone.warning,
        icon: Icons.warning_amber_rounded,
        text: 'Not searchable yet — the assistant can’t use it until it is.',
        actionLabel: canRun ? 'Make searchable' : null,
        onAction: canRun && !_starting ? _makeSearchable : null,
      );
    }
    if (processing.state == 'unsupported') {
      return const InlineNotice(
        text:
            'This kind of file can’t be searched. You can still read it here.',
      );
    }
    return null;
  }

  Widget _content(KnowledgeViewer viewer) {
    final colors = context.colors;
    final pages = viewer.assets.isNotEmpty;
    final stage = _stage ?? (pages ? _Stage.pages : _Stage.text);
    if (pages && stage == _Stage.pages) {
      return SliverToBoxAdapter(
        child: PageViewer(
          key: ValueKey(widget.documentId),
          viewer: viewer,
          onRetry: () => _load(quiet: true),
        ),
      );
    }
    if (viewer.renditionUrl.isNotEmpty && _renditionError == null) {
      final rendition = _rendition;
      if (rendition == null) {
        return const SliverToBoxAdapter(
          child: LoadingView(label: 'Loading the document'),
        );
      }
      final cited = citedTargets(
        rendition,
        viewer.citedElementIds,
        viewer.quote,
      );
      return RenditionSliver(
        rendition: rendition,
        spreadsheet: viewer.isSpreadsheet,
        citedBlocks: cited.blocks,
        citedRows: cited.rows,
        firstCitedKey: _firstCited,
      );
    }
    final failed = _renditionError != null
        ? Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: InlineNotice(
              tone: StatusTone.danger,
              text: friendlyError(_renditionError!),
              actionLabel: 'Try again',
              onAction: () async {
                // A fresh viewer read re-signs the link.
                await _load(quiet: true);
                final fresh = _viewer;
                if (fresh != null) {
                  await _loadRendition(fresh, retry: true);
                }
              },
            ),
          )
        : null;
    if (viewer.elements.isNotEmpty) {
      return SliverMainAxisGroup(
        slivers: [
          if (failed != null) SliverToBoxAdapter(child: failed),
          ElementsSliver(
            elements: viewer.elements,
            cited: viewer.citedElementIds,
            firstCitedKey: _firstCited,
          ),
        ],
      );
    }
    return SliverToBoxAdapter(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ?failed,
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              color: colors.subtle,
              borderRadius: BorderRadius.circular(14),
            ),
            child: Text(
              viewer.status == 'pending_content'
                  ? 'Its content is still arriving.'
                  : viewer.originalUrl.isNotEmpty
                  ? 'There’s no preview of this file yet. Download it from “···” to read it.'
                  : 'There’s no preview of this file yet.',
              textAlign: TextAlign.center,
              style: TextStyle(color: colors.ink3, fontSize: 14, height: 1.45),
            ),
          ),
        ],
      ),
    );
  }
}
