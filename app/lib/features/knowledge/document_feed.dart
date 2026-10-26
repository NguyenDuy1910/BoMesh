import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../ui/ui.dart';
import 'knowledge_models.dart';
import 'knowledge_widgets.dart';

/// One paged read of `GET /documents`: a collection's documents, or every
/// readable one, optionally filtered by name.
///
/// While a listed document is becoming searchable, or a run started from the
/// screen is still queued or running, the feed re-reads what is on screen
/// every few seconds so rows update in place.
class DocumentFeed extends ChangeNotifier {
  DocumentFeed(this.api, {
    this.collectionId,
    this.search = '',
    this.processingFilter = '',
  });
  final ApiClient api;
  final String? collectionId;
  final String search;
  /// Processing filters are local because GET /documents has no such filter.
  /// All pages are read before filtering so failures are never hidden by paging.
  final String processingFilter;

  static const pageSize = 30;

  List<KnowledgeDocument> documents = const [];
  int total = 0;
  bool loading = true, loadingMore = false;
  Object? error;

  final Set<String> _runs = {};
  Timer? _poll;
  int _request = 0;
  bool _disposed = false;

  bool get hasMore => documents.length < total;

  /// Keep refreshing until [runId] finishes.
  void follow(String runId) {
    if (runId.isEmpty) return;
    _runs.add(runId);
    _schedule();
  }

  /// Whether a run started here is still being followed.
  bool get following => _runs.isNotEmpty;

  /// Read the first page, or quietly re-read everything on screen.
  Future<void> load({bool quiet = false}) async {
    _poll?.cancel();
    final request = ++_request;
    if (!quiet) {
      loading = true;
      error = null;
      _notify();
    }
    try {
      final finished = <String>{};
      for (final run in _runs.toList()) {
        try {
          if (!await processingIsActive(api, run)) finished.add(run);
        } catch (_) {
          // A run that cannot be read can no longer be followed; the
          // documents' own states still show where they stand.
          finished.add(run);
        }
      }
      final size = quiet && documents.length > pageSize
          ? (documents.length > 100 ? 100 : documents.length)
          : pageSize;
      final value = await _read(page: 1, size: size);
      if (_disposed || request != _request) return;
      _runs.removeAll(finished);
      documents = value.$1;
      total = value.$2;
      loading = false;
      error = null;
      _notify();
      _schedule();
    } catch (cause) {
      if (_disposed || request != _request) return;
      loading = false;
      if (!quiet) error = cause;
      _notify();
    }
  }

  /// The next page after what is on screen.
  Future<void> more() async {
    if (loadingMore || !hasMore) return;
    final request = _request;
    loadingMore = true;
    _notify();
    try {
      final value = await _read(
        page: documents.length ~/ pageSize + 1,
        size: pageSize,
      );
      if (_disposed || request != _request) return;
      final seen = {for (final document in documents) document.id};
      documents = [
        ...documents,
        ...value.$1.where((document) => !seen.contains(document.id)),
      ];
      total = value.$2;
    } finally {
      if (!_disposed && request == _request) {
        loadingMore = false;
        _notify();
      }
    }
  }

  Future<(List<KnowledgeDocument>, int)> _read({
    required int page,
    required int size,
  }) async {
    if (processingFilter.isNotEmpty) {
      final matches = <KnowledgeDocument>[];
      var readCount = 0;
      for (var number = 1; ; number++) {
        final result = await api.get('/documents', query: {
          'collection_id': collectionId,
          'search': search,
          'page': number,
          'page_size': 100,
        });
        if (_disposed) return (const <KnowledgeDocument>[], 0);
        final batch = objectList(result['items']);
        readCount += batch.length;
        for (final value in batch) {
          final document = KnowledgeDocument.fromJson(value);
          final include = switch (processingFilter) {
            'attention' => document.processing.notSearchable ||
                document.processing.isProcessing,
            'failed' => document.processing.isFailed,
            'processing' => document.processing.isProcessing,
            _ => true,
          };
          if (include) matches.add(document);
        }
        if (batch.isEmpty || readCount >= intOf(result['total'])) break;
      }
      return (matches, matches.length);
    }
    final value = await api.get(
      '/documents',
      query: {
        'page': page,
        'page_size': size,
        'collection_id': collectionId,
        'search': search,
      },
    );
    return (
      objectList(value['items']).map(KnowledgeDocument.fromJson).toList(),
      intOf(value['total']),
    );
  }

  void _schedule() {
    _poll?.cancel();
    if (_disposed) return;
    if (_runs.isNotEmpty ||
        documents.any((document) => document.processing.isProcessing)) {
      _poll = Timer(const Duration(seconds: 5), () => load(quiet: true));
    }
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _request++;
    _poll?.cancel();
    super.dispose();
  }
}

/// A feed's rows: loading, failure, nothing, or the rows with Show more.
class DocumentFeedView extends StatelessWidget {
  const DocumentFeedView({
    super.key,
    required this.feed,
    required this.empty,
    this.onRetryDocument,
    this.retrying = const {},
  });
  final DocumentFeed feed;
  final Widget empty;
  final Future<void> Function(KnowledgeDocument document)? onRetryDocument;
  final Set<String> retrying;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: feed,
    builder: (context, _) {
      if (feed.loading && feed.documents.isEmpty) return const LoadingView();
      if (feed.error != null) {
        return ErrorView(
          error: feed.error!,
          title: 'Files couldn’t be loaded',
          onRetry: feed.load,
        );
      }
      if (feed.documents.isEmpty) return empty;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ListGroup(
            children: [
              for (final document in feed.documents)
                DocumentRow(
                  key: ValueKey(document.id),
                  document: document,
                  onReturn: () => feed.load(quiet: true),
                  onRetry: onRetryDocument != null && document.needsRun
                      ? () => onRetryDocument!(document)
                      : null,
                  retrying: retrying.contains(document.id),
                ),
            ],
          ),
          if (feed.hasMore)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Center(
                child: feed.loadingMore
                    ? const Padding(
                        padding: EdgeInsets.all(12),
                        child: SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      )
                    : TextButton(
                        onPressed: () async {
                          try {
                            await feed.more();
                          } catch (error) {
                            if (context.mounted) showError(context, error);
                          }
                        },
                        child: const Text('Show more'),
                      ),
              ),
            ),
        ],
      );
    },
  );
}
