import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../ui/ui.dart';
import 'state/chat_controller.dart';

/// "Choose from Library": every document the person can read, newest
/// first; tapping one adds it to the question.
class LibraryPickerPage extends StatefulWidget {
  const LibraryPickerPage({super.key, required this.controller});
  final ChatController controller;

  @override
  State<LibraryPickerPage> createState() => _LibraryPickerPageState();
}

class _LibraryPickerPageState extends State<LibraryPickerPage> {
  static const _pageSize = 40;
  final _scroll = ScrollController();
  Timer? _debounce;
  String _query = '';
  List<JsonMap> _documents = [];
  int _total = 0;
  int _page = 0;
  int _request = 0;
  bool _loading = true;
  bool _loadingMore = false;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    unawaited(_load());
  }

  @override
  void dispose() {
    _request++;
    _debounce?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final request = ++_request;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final result = await widget.controller.service.listDocuments(
        search: _query,
        pageSize: _pageSize,
      );
      if (!mounted || request != _request) return;
      setState(() {
        _documents = result.items;
        _total = result.total;
        _page = 1;
      });
    } catch (cause) {
      if (mounted && request == _request) setState(() => _error = cause);
    } finally {
      if (mounted && request == _request) setState(() => _loading = false);
    }
  }

  void _onScroll() {
    if (_loading ||
        _loadingMore ||
        _page * _pageSize >= _total ||
        _scroll.position.extentAfter > 400) {
      return;
    }
    unawaited(_loadMore());
  }

  Future<void> _loadMore() async {
    final request = _request;
    setState(() => _loadingMore = true);
    try {
      final result = await widget.controller.service.listDocuments(
        search: _query,
        page: _page + 1,
        pageSize: _pageSize,
      );
      if (!mounted || request != _request) return;
      setState(() {
        _documents = [..._documents, ...result.items];
        _total = result.total;
        _page += 1;
      });
    } catch (cause) {
      if (mounted) showError(context, cause);
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  void _search(String value) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () {
      if (!mounted || value.trim() == _query.trim()) return;
      _query = value;
      unawaited(_load());
    });
  }

  void _choose(JsonMap document) {
    widget.controller.referenceDocument(
      textOf(document['id']),
      textOf(document['name'], 'Document'),
    );
    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final Widget body;
    if (_loading && _documents.isEmpty) {
      body = const LoadingView();
    } else if (_error != null && _documents.isEmpty) {
      body = ErrorView(error: _error!, onRetry: _load);
    } else if (_documents.isEmpty) {
      body = EmptyView(
        icon: Icons.local_library_outlined,
        title: _query.trim().isEmpty ? 'No documents yet' : 'Nothing found',
        message: _query.trim().isEmpty
            ? 'Files you upload or that are shared with you appear here.'
            : 'Try another name.',
      );
    } else {
      body = RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          controller: _scroll,
          padding: kPagePadding,
          children: [
            ListGroup(
              children: [for (final document in _documents) _row(document)],
            ),
            if (_loadingMore)
              const Padding(
                padding: EdgeInsets.all(16),
                child: Center(
                  child: SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ),
              ),
          ],
        ),
      );
    }
    return Scaffold(
      appBar: const AppHeader(
        title: 'Choose from Library',
        subtitle: 'Add a document to this question',
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
            child: AppSearchField(
              hint: 'Search your files',
              onChanged: _search,
            ),
          ),
          Expanded(child: body),
        ],
      ),
    );
  }

  Widget _row(JsonMap document) {
    final colors = context.colors;
    final id = textOf(document['id']);
    final name = textOf(document['name'], 'Untitled document');
    final contentType = textOf(document['content_type']);
    final searchable =
        textOf(objectOf(document['processing'])['state']) == 'ready';
    final chosen = widget.controller.attachments.any(
      (value) => value.document?.id == id,
    );
    return ListRow(
      leading: FileTile(contentType: contentType, name: name),
      title: name,
      subtitleWidget: Text.rich(
        TextSpan(
          children: [
            TextSpan(
              text: [
                FileKind.typeWord(contentType: contentType, name: name),
                if (intOf(document['size_bytes']) > 0)
                  readableBytes(intOf(document['size_bytes'])),
              ].join(' · '),
            ),
            if (!searchable)
              TextSpan(
                text: ' · Not searchable yet',
                style: TextStyle(color: colors.warning),
              ),
          ],
        ),
      ),
      trailing: chosen
          ? Icon(Icons.check_circle_rounded, color: colors.brand, size: 22)
          : null,
      chevron: false,
      onTap: chosen ? () => Navigator.pop(context) : () => _choose(document),
    );
  }
}
