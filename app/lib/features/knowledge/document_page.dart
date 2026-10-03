import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/app_theme.dart';
import '../../core/api_client.dart';
import 'knowledge_models.dart';
import 'knowledge_widgets.dart';

/// A source is always resolved afresh through the permission-checked viewer.
/// Opening a citation never changes ownership or deletes a referenced document.
class DocumentPage extends StatefulWidget {
  const DocumentPage({
    super.key,
    required this.api,
    required this.documentId,
    this.chunkId,
    this.onAskDocument,
  });
  final ApiClient api;
  final String documentId;
  final String? chunkId;
  final void Function(String documentId, String title)? onAskDocument;
  @override
  State<DocumentPage> createState() => _DocumentPageState();
}

class _DocumentPageState extends State<DocumentPage> {
  KnowledgeViewer? _viewer;
  KnowledgeDocument? _document;
  String? _error;
  bool _loading = true;
  bool _restricted = false;
  int _request = 0;
  int _assetIndex = 0;
  String _tab = 'preview';
  String _query = '';
  final _search = TextEditingController();
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant DocumentPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.documentId != widget.documentId ||
        oldWidget.chunkId != widget.chunkId ||
        oldWidget.api != widget.api) {
      _assetIndex = 0;
      _query = '';
      _search.clear();
      _load();
    }
  }

  @override
  void dispose() {
    _request++;
    _poll?.cancel();
    _search.dispose();
    super.dispose();
  }

  Future<void> _load({bool quiet = false}) async {
    _poll?.cancel();
    final request = ++_request;
    final token = widget.api.accessToken;
    if (!quiet) {
      setState(() {
        _loading = true;
        _error = null;
        _viewer = null;
        _document = null;
      });
    }
    try {
      final values = await Future.wait([
        widget.api.get(
          '/knowledge/documents/${Uri.encodeComponent(widget.documentId)}',
          query: {'chunk': widget.chunkId},
        ),
        widget.api.get('/documents/${Uri.encodeComponent(widget.documentId)}'),
      ]);
      if (!mounted || request != _request || token != widget.api.accessToken) {
        return;
      }
      final viewer = KnowledgeViewer.fromJson(values[0]);
      final document = KnowledgeDocument.fromJson(values[1]);
      final focusIndex = viewer.assets.indexWhere(
        (asset) => asset.page == viewer.focusPage,
      );
      setState(() {
        _viewer = viewer;
        _document = document;
        _loading = false;
        _error = null;
        _restricted = false;
        if (!quiet && focusIndex >= 0) _assetIndex = focusIndex;
        if (_assetIndex >= viewer.assets.length) _assetIndex = 0;
      });
      if (document.isActive) {
        _poll = Timer(const Duration(seconds: 5), () => _load(quiet: true));
      }
    } catch (error) {
      if (!mounted || request != _request || token != widget.api.accessToken) {
        return;
      }
      setState(() {
        _loading = false;
        _viewer = null;
        _document = null;
        _restricted =
            error is ApiException && [401, 403, 404].contains(error.status);
        _error = error.toString();
      });
    }
  }

  Future<void> _openOriginal({bool external = false}) async {
    try {
      // Signed URLs are short-lived: reauthorize immediately before opening.
      final value = await widget.api.get(
        '/knowledge/documents/${Uri.encodeComponent(widget.documentId)}',
        query: {'chunk': widget.chunkId},
      );
      if (!mounted) return;
      final viewer = KnowledgeViewer.fromJson(value);
      final uri = Uri.tryParse(
        external ? viewer.externalUrl : viewer.originalUrl,
      );
      if (uri == null ||
          !['http', 'https'].contains(uri.scheme) ||
          uri.host.isEmpty) {
        throw const ApiException(
          'No safe source link is available for this document.',
        );
      }
      final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
      if (!opened) {
        throw const ApiException('No application could open this source.');
      }
    } catch (error) {
      if (!mounted) return;
      if (error is ApiException && [401, 403, 404].contains(error.status)) {
        setState(() {
          _viewer = null;
          _document = null;
          _restricted = true;
          _error = error.toString();
        });
      } else {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.toString())));
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(
        _viewer?.title ?? 'Document',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      actions: [
        IconButton(
          tooltip: 'Refresh document',
          onPressed: _loading ? null : _load,
          icon: const Icon(Icons.refresh),
        ),
      ],
    ),
    body: SafeArea(
      top: false,
      child: _loading
          ? const Center(
              child: CircularProgressIndicator(
                semanticsLabel: 'Opening document',
              ),
            )
          : _error != null
          ? ListView(
              padding: const EdgeInsets.all(24),
              children: [
                KnowledgeNotice(
                  title: _restricted
                      ? 'This source is not available to your account'
                      : 'Document could not be opened',
                  message: _restricted
                      ? 'It may have been removed or its permissions changed. No source content is shown.'
                      : _error,
                  icon: _restricted ? Icons.lock_outline : Icons.error_outline,
                  onAction: _load,
                  danger: !_restricted,
                ),
              ],
            )
          : _viewer == null
          ? const SizedBox.shrink()
          : _content(),
    ),
  );

  Widget _content() {
    final viewer = _viewer!;
    return Align(
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 920),
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    viewer.title,
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 6),
                  Text(
                    viewer.contentType,
                    style: TextStyle(color: context.colors.textSecondary),
                  ),
                  const SizedBox(height: 16),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      if (viewer.originalUrl.isNotEmpty)
                        OutlinedButton.icon(
                          onPressed: _openOriginal,
                          icon: const Icon(Icons.open_in_new, size: 18),
                          label: const Text('Open original'),
                        ),
                      if (widget.onAskDocument != null &&
                          viewer.status == 'available')
                        FilledButton.icon(
                          onPressed: () => widget.onAskDocument!(
                            widget.documentId,
                            viewer.title,
                          ),
                          icon: const Icon(Icons.chat_bubble_outline, size: 18),
                          label: const Text('Ask document'),
                        ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  SizedBox(
                    width: double.infinity,
                    child: SegmentedButton<String>(
                      segments: const [
                        ButtonSegment(value: 'preview', label: Text('Preview')),
                        ButtonSegment(value: 'text', label: Text('Text')),
                        ButtonSegment(value: 'details', label: Text('Details')),
                      ],
                      selected: {_tab},
                      showSelectedIcon: false,
                      onSelectionChanged: (value) =>
                          setState(() => _tab = value.first),
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _load,
                child: _tab == 'text'
                    ? _textView(viewer)
                    : _tab == 'details'
                    ? _details(viewer)
                    : _preview(viewer),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _quote(KnowledgeViewer viewer) => Container(
    padding: const EdgeInsets.all(20),
    margin: const EdgeInsets.only(bottom: 16),
    decoration: BoxDecoration(
      color: context.colors.brandSoft,
      borderRadius: BorderRadius.circular(16),
      border: Border(left: BorderSide(color: context.colors.brand, width: 4)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'Cited passage',
                style: Theme.of(context).textTheme.titleSmall,
              ),
            ),
            IconButton(
              tooltip: 'Copy cited passage',
              icon: const Icon(Icons.copy_outlined, size: 20),
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: viewer.quote));
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Passage copied')),
                  );
                }
              },
            ),
          ],
        ),
        if (viewer.section.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              viewer.section,
              style: TextStyle(color: context.colors.brand),
            ),
          ),
        SelectableText(viewer.quote, style: const TextStyle(height: 1.6)),
      ],
    ),
  );

  Widget _preview(KnowledgeViewer viewer) {
    final asset = viewer.assets.isEmpty ? null : viewer.assets[_assetIndex];
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        if (viewer.quote.isNotEmpty) _quote(viewer),
        if (widget.chunkId?.isNotEmpty == true && viewer.quote.isEmpty)
          const Padding(
            padding: EdgeInsets.only(bottom: 16),
            child: Text(
              'No exact passage is available for this citation. The original source is not reconstructed.',
            ),
          ),
        if (asset != null) ...[
          Row(
            children: [
              IconButton(
                tooltip: 'Previous page',
                onPressed: _assetIndex > 0
                    ? () => setState(() => _assetIndex--)
                    : null,
                icon: const Icon(Icons.chevron_left),
              ),
              Expanded(
                child: Text(
                  'Page ${asset.page > 0 ? asset.page : _assetIndex + 1}${viewer.pageCount > 0 ? ' of ${viewer.pageCount}' : ''}',
                  textAlign: TextAlign.center,
                ),
              ),
              IconButton(
                tooltip: 'Next page',
                onPressed: _assetIndex + 1 < viewer.assets.length
                    ? () => setState(() => _assetIndex++)
                    : null,
                icon: const Icon(Icons.chevron_right),
              ),
            ],
          ),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(16),
            child: ColoredBox(
              color: context.colors.surface,
              child: AspectRatio(
                aspectRatio: asset.width > 0 && asset.height > 0
                    ? asset.width / asset.height
                    : .707,
                child: InteractiveViewer(
                  minScale: 1,
                  maxScale: 5,
                  child: LayoutBuilder(
                    builder: (context, constraints) => Image.network(
                      asset.url,
                      key: ValueKey(asset.url),
                      width: constraints.maxWidth,
                      height: constraints.maxHeight,
                      fit: BoxFit.contain,
                      semanticLabel:
                          '${viewer.title}, page ${asset.page > 0 ? asset.page : _assetIndex + 1}',
                      loadingBuilder: (context, child, progress) =>
                          progress == null
                          ? child
                          : const Center(
                              child: CircularProgressIndicator(
                                semanticsLabel: 'Loading source page',
                              ),
                            ),
                      errorBuilder: (context, error, stack) => Center(
                        child: SingleChildScrollView(
                          padding: const EdgeInsets.all(16),
                          child: KnowledgeNotice(
                            title: 'This page could not be loaded',
                            message: 'Check your connection, then try again. The Text tab still shows the document’s content.',
                            onAction: _load,
                            actionLabel: 'Try again',
                          ),
                        ),
                      ),
                      frameBuilder: (context, child, frame, synchronous) {
                        if (frame == null && !synchronous) return child;
                        final regions = viewer.normalizedCoordinates
                            ? viewer.regions.where(
                                (region) =>
                                    region.page == asset.page &&
                                    region.width > 0 &&
                                    region.height > 0,
                              )
                            : <CitationRegion>[];
                        return Stack(
                          fit: StackFit.expand,
                          children: [
                            child,
                            for (final region in regions)
                              Positioned(
                                left: region.x * constraints.maxWidth,
                                top: region.y * constraints.maxHeight,
                                width: region.width * constraints.maxWidth,
                                height: region.height * constraints.maxHeight,
                                child: IgnorePointer(
                                  child: ColoredBox(
                                    color: context.colors.brand.withValues(
                                      alpha: .20,
                                    ),
                                  ),
                                ),
                              ),
                          ],
                        );
                      },
                    ),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'Pinch to zoom. Swipe within a zoomed page to pan.',
            style: Theme.of(context).textTheme.bodySmall,
            textAlign: TextAlign.center,
          ),
          if (viewer.truncated)
            const Padding(
              padding: EdgeInsets.only(top: 12),
              child: Text(
                'Only some page previews are available. Open the original for the complete document.',
              ),
            ),
        ] else
          KnowledgeNotice(
            title: viewer.status == 'pending_content'
                ? 'Waiting for content'
                : 'No rendered page preview',
            message: 'Read the indexed text or open the original document. Missing pages are never recreated from an answer.',
            actionLabel: 'Read text',
            onAction: () => setState(() => _tab = 'text'),
            icon: Icons.description_outlined,
          ),
      ],
    );
  }

  Widget _textView(KnowledgeViewer viewer) {
    final needle = _query.toLowerCase().trim();
    final elements = viewer.elements
        .where(
          (element) =>
              needle.isEmpty || element.text.toLowerCase().contains(needle),
        )
        .toList();
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        TextField(
          controller: _search,
          decoration: const InputDecoration(
            labelText: 'Find in available text',
            prefixIcon: Icon(Icons.search),
          ),
          onChanged: (value) => setState(() => _query = value),
        ),
        const SizedBox(height: 16),
        if (viewer.quote.isNotEmpty && needle.isEmpty) _quote(viewer),
        if (elements.isEmpty)
          KnowledgeNotice(
            title: needle.isEmpty
                ? 'No indexed text available'
                : 'No matching passages',
            message: needle.isEmpty
                ? 'Content may still be indexing, or this format has no searchable text layer. Open the original to read it.'
                : 'Try another phrase. Search covers the text returned for this viewer.',
          ),
        for (final element in elements)
          Container(
            margin: const EdgeInsets.only(bottom: 12),
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              color:
                  viewer.regions.any((region) => region.elementId == element.id)
                  ? context.colors.brandSoft
                  : context.colors.surface,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: context.colors.border),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (element.page > 0 || element.section.isNotEmpty) ...[
                  Text(
                    [
                      if (element.page > 0) 'Page ${element.page}',
                      if (element.section.isNotEmpty) element.section,
                    ].join(' · '),
                    style: Theme.of(context).textTheme.labelMedium
                        ?.copyWith(color: context.colors.brand),
                  ),
                  const SizedBox(height: 12),
                ],
                SelectableText(
                  element.text,
                  style: const TextStyle(height: 1.65),
                ),
              ],
            ),
          ),
        if (elements.isNotEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Text(
              widget.chunkId == null
                  ? 'Indexed source text. Long documents may include only the first 100 indexed passages; the original contains the complete file.'
                  : 'Text is focused on the cited passage.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
      ],
    );
  }

  Widget _details(KnowledgeViewer viewer) => ListView(
    padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
    physics: const AlwaysScrollableScrollPhysics(),
    children: [
      if (_document != null) IngestionProgressCard(document: _document!),
      const SizedBox(height: 16),
      Card(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Source information',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 16),
              _fact('Access', 'Authorized for this account'),
              _fact('Format', viewer.contentType),
              if (_document != null) ...[
                _fact('Size', readableBytes(_document!.size)),
                _fact('Created', readableDate(_document!.createdAt)),
                _fact('Updated', readableDate(_document!.updatedAt)),
                _fact('Purpose', sentenceCase(_document!.purpose)),
              ],
              if (viewer.section.isNotEmpty)
                _fact('Cited section', viewer.section),
              if (viewer.focusPage > 0)
                _fact('Cited page', '${viewer.focusPage}'),
              if (viewer.externalUrl.isNotEmpty) ...[
                _fact(
                  'Source',
                  Uri.tryParse(viewer.externalUrl)?.host ?? 'External source',
                ),
                OutlinedButton.icon(
                  onPressed: () => _openOriginal(external: true),
                  icon: const Icon(Icons.open_in_new),
                  label: const Text('Visit source'),
                ),
              ],
              const SizedBox(height: 8),
              Text(
                'Originals and page previews use temporary signed links. Refreshing rechecks your access.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
        ),
      ),
    ],
  );

  Widget _fact(String label, String value) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: Theme.of(context).textTheme.labelMedium
              ?.copyWith(color: context.colors.textSecondary),
        ),
        const SizedBox(height: 4),
        SelectableText(value),
      ],
    ),
  );
}
