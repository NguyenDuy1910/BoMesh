import 'package:flutter/material.dart';

import '../../../app/app_theme.dart';
import '../../../core/api_client.dart';
import '../../knowledge/document_page.dart';
import '../state/chat_controller.dart';

class DocumentPicker extends StatefulWidget {
  const DocumentPicker({super.key, required this.controller});
  final ChatController controller;
  @override
  State<DocumentPicker> createState() => _DocumentPickerState();
}

class _DocumentPickerState extends State<DocumentPicker> {
  final _query = TextEditingController();
  List<JsonMap> _results = [];
  String? _error;
  bool _busy = false;
  bool _searched = false;
  int _request = 0;

  @override
  void dispose() {
    _request += 1;
    _query.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    final query = _query.text.trim();
    if (query.isEmpty || query.length > 512) return;
    final request = ++_request;
    setState(() {
      _busy = true;
      _error = null;
      _searched = true;
    });
    try {
      final values = await widget.controller.service.searchDocuments(
        query,
        widget.controller.selectedCollectionIds.toList(),
      );
      if (!mounted || request != _request) return;
      setState(() => _results = values);
    } catch (cause) {
      if (mounted && request == _request) {
        setState(() => _error = cause.toString());
      }
    } finally {
      if (mounted && request == _request) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.fromLTRB(
      20,
      12,
      20,
      MediaQuery.viewInsetsOf(context).bottom + 16,
    ),
    child: SizedBox(
      height: MediaQuery.sizeOf(context).height * 0.68,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'Ask about a document',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),
              IconButton(
                tooltip: 'Close document search',
                onPressed: () => Navigator.pop(context),
                icon: const Icon(Icons.close),
              ),
            ],
          ),
          const Text(
            'Search the knowledge you can access, then attach the original document to your next question.',
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _query,
            maxLength: 512,
            textInputAction: TextInputAction.search,
            onSubmitted: (_) => _search(),
            decoration: InputDecoration(
              labelText: 'Find documents',
              prefixIcon: const Icon(Icons.search),
              suffixIcon: IconButton(
                tooltip: 'Search documents',
                onPressed: _busy ? null : _search,
                icon: const Icon(Icons.arrow_forward),
              ),
            ),
          ),
          Expanded(
            child: _busy
                ? const Center(child: CircularProgressIndicator())
                : _error != null
                ? Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          _error!,
                          textAlign: TextAlign.center,
                          style: TextStyle(color: context.colors.danger),
                        ),
                        TextButton.icon(
                          onPressed: _search,
                          icon: const Icon(Icons.refresh),
                          label: const Text('Retry search'),
                        ),
                      ],
                    ),
                  )
                : _results.isEmpty
                ? Center(
                    child: Text(
                      _searched
                          ? 'No matching documents. Try a more specific question.'
                          : 'Search a topic, phrase or question.',
                    ),
                  )
                : ListView.separated(
                    itemCount: _results.length,
                    separatorBuilder: (_, _) => const Divider(),
                    itemBuilder: (context, index) {
                      final document = _results[index];
                      final id = textOf(document['document_id']);
                      final name = textOf(
                        document['name'],
                        'Untitled document',
                      );
                      final selected = widget.controller.attachments.any(
                        (value) => value.document?.id == id,
                      );
                      return Padding(
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              name,
                              style: Theme.of(context).textTheme.titleSmall,
                            ),
                            const SizedBox(height: 8),
                            Text(
                              textOf(document['excerpt']),
                              maxLines: 4,
                              overflow: TextOverflow.ellipsis,
                              style: Theme.of(context).textTheme.bodyMedium,
                            ),
                            Wrap(
                              spacing: 8,
                              children: [
                                TextButton.icon(
                                  onPressed: () => Navigator.of(context).push(
                                    MaterialPageRoute<void>(
                                      builder: (_) => DocumentPage(
                                        api: widget.controller.api,
                                        documentId: id,
                                      ),
                                    ),
                                  ),
                                  icon: const Icon(Icons.visibility_outlined),
                                  label: const Text('View'),
                                ),
                                FilledButton.tonalIcon(
                                  onPressed: selected
                                      ? null
                                      : () {
                                          widget.controller.referenceDocument(
                                            id,
                                            name,
                                          );
                                          Navigator.pop(context);
                                        },
                                  icon: Icon(
                                    selected
                                        ? Icons.check
                                        : Icons.add_comment_outlined,
                                  ),
                                  label: Text(
                                    selected ? 'Attached' : 'Ask about this',
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    ),
  );
}
