import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../../app/app_theme.dart';
import '../../core/api_client.dart';

String directoryName(JsonMap row) =>
    textOf(row['display_name']).trim().isNotEmpty
    ? textOf(row['display_name'])
    : textOf(row['email'], textOf(row['code'], 'Unnamed'));

Set<String> referenceIds(Object? value) =>
    objectList(value).map((row) => textOf(row['id'])).toSet();
Set<String> stringSet(Object? value) =>
    value is List ? value.map((item) => item.toString()).toSet() : <String>{};

String friendlyLabel(String value) {
  final words = value.replaceAll(RegExp(r'[_.-]+'), ' ').trim();
  return words.isEmpty
      ? 'Not provided'
      : '${words[0].toUpperCase()}${words.substring(1)}';
}

String recordedAt(Object? value) {
  final date = DateTime.tryParse(textOf(value))?.toLocal();
  if (date == null) return 'Not recorded';
  String two(int value) => value.toString().padLeft(2, '0');
  return '${date.year}-${two(date.month)}-${two(date.day)} · ${two(date.hour)}:${two(date.minute)}';
}

String? requiredText(String? value) =>
    value == null || value.trim().isEmpty ? 'Please fill in this field.' : null;

Future<List<JsonMap>> allDirectoryRows(ApiClient api, String path) async {
  final rows = <JsonMap>[];
  final accessToken = api.accessToken;
  var page = 1;
  while (true) {
    if (api.accessToken != accessToken) {
      throw StateError(
        'Your workspace changed. Reopen this screen to continue.',
      );
    }
    final response = await api.get(
      path,
      query: {'page': page, 'page_size': 100},
    );
    final batch = objectList(response['items']);
    rows.addAll(batch);
    final total = response['total'] as num?;
    if (batch.isEmpty ||
        (total != null && rows.length >= total) ||
        (total == null && batch.length < 100)) {
      return rows;
    }
    page++;
  }
}

Future<bool> confirmWorkspaceAction(
  BuildContext context, {
  required String title,
  required String message,
  required String action,
  bool destructive = false,
}) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(message),
        scrollable: true,
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep unchanged'),
          ),
          FilledButton(
            style: destructive
                ? FilledButton.styleFrom(
                    backgroundColor: Theme.of(context).colorScheme.error,
                  )
                : null,
            onPressed: () => Navigator.pop(context, true),
            child: Text(action),
          ),
        ],
      ),
    ) ??
    false;

class WorkspaceBody extends StatelessWidget {
  const WorkspaceBody({super.key, required this.children});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) => SingleChildScrollView(
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      padding: EdgeInsets.fromLTRB(
        constraints.maxWidth < 600 ? 16 : 24,
        16,
        constraints.maxWidth < 600 ? 16 : 24,
        32,
      ),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 880),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: children,
          ),
        ),
      ),
    ),
  );
}

class WorkspaceCard extends StatelessWidget {
  const WorkspaceCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(20),
  });
  final Widget child;
  final EdgeInsetsGeometry padding;
  @override
  Widget build(BuildContext context) => Card(
    margin: const EdgeInsets.only(bottom: 16),
    color: context.colors.surface,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(20),
      side: BorderSide(color: context.colors.border),
    ),
    child: Padding(padding: padding, child: child),
  );
}

class WorkspaceNotice extends StatelessWidget {
  const WorkspaceNotice(
    this.message, {
    super.key,
    this.error = false,
    this.onRetry,
  });
  final String message;
  final bool error;
  final VoidCallback? onRetry;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: Semantics(
      liveRegion: true,
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: error ? context.colors.dangerSoft : context.colors.brandSoft,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  error
                      ? Icons.error_outline_rounded
                      : Icons.info_outline_rounded,
                  color: error ? context.colors.danger : context.colors.brand,
                  size: 22,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    message,
                    style: TextStyle(color: context.colors.textPrimary),
                  ),
                ),
              ],
            ),
            if (onRetry != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: TextButton.icon(
                  onPressed: onRetry,
                  icon: const Icon(Icons.refresh_rounded),
                  label: const Text('Try again'),
                ),
              ),
          ],
        ),
      ),
    ),
  );
}

class WorkspaceEmpty extends StatelessWidget {
  const WorkspaceEmpty({
    super.key,
    required this.title,
    required this.message,
    this.icon = Icons.inbox_outlined,
  });
  final String title, message;
  final IconData icon;
  @override
  Widget build(BuildContext context) => WorkspaceCard(
    child: Padding(
      padding: const EdgeInsets.symmetric(vertical: 24),
      child: Column(
        children: [
          Icon(icon, size: 40, color: context.colors.brand),
          const SizedBox(height: 16),
          Text(
            title,
            style: Theme.of(context).textTheme.titleMedium,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 8),
          Text(
            message,
            style: TextStyle(color: context.colors.textSecondary),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    ),
  );
}

class WorkspaceStatus extends StatelessWidget {
  const WorkspaceStatus(this.status, {super.key});
  final String status;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
    decoration: BoxDecoration(
      color: context.colors.subtle,
      borderRadius: BorderRadius.circular(8),
    ),
    child: Text(
      friendlyLabel(status),
      style: Theme.of(context).textTheme.labelMedium,
    ),
  );
}

class WorkspaceField extends StatelessWidget {
  const WorkspaceField(this.label, this.value, {super.key});
  final String label, value;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: TextStyle(color: context.colors.textSecondary, fontSize: 13),
        ),
        const SizedBox(height: 5),
        SelectableText(value.isEmpty ? 'Not provided' : value),
      ],
    ),
  );
}

class WorkspaceJsonDetails extends StatelessWidget {
  const WorkspaceJsonDetails(this.details, {super.key});
  final JsonMap details;
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: details.entries
        .map(
          (entry) => WorkspaceField(
            friendlyLabel(entry.key),
            entry.value is Map || entry.value is List
                ? const JsonEncoder.withIndent('  ').convert(entry.value)
                : textOf(entry.value, 'Not provided'),
          ),
        )
        .toList(),
  );
}

class WorkspaceSaveButton extends StatelessWidget {
  const WorkspaceSaveButton({
    super.key,
    required this.busy,
    required this.onPressed,
    this.label = 'Save changes',
  });
  final bool busy;
  final VoidCallback onPressed;
  final String label;
  @override
  Widget build(BuildContext context) => SizedBox(
    height: 52,
    child: FilledButton.icon(
      onPressed: busy ? null : onPressed,
      icon: busy
          ? const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : const Icon(Icons.check_rounded),
      label: Text(busy ? 'Saving…' : label),
    ),
  );
}

class WorkspacePagedDirectory extends StatefulWidget {
  const WorkspacePagedDirectory({
    super.key,
    required this.api,
    required this.path,
    required this.title,
    required this.description,
    required this.rowBuilder,
    this.onOpen,
    this.onCreate,
    this.createLabel,
    this.searchable = true,
    this.onChanged,
  });
  final ApiClient api;
  final String path, title, description;
  final Widget Function(BuildContext, JsonMap, VoidCallback?) rowBuilder;
  final Future<bool?> Function(JsonMap)? onOpen;
  final Future<bool?> Function()? onCreate;
  final Future<void> Function()? onChanged;
  final String? createLabel;
  final bool searchable;
  @override
  State<WorkspacePagedDirectory> createState() =>
      _WorkspacePagedDirectoryState();
}

class _WorkspacePagedDirectoryState extends State<WorkspacePagedDirectory> {
  final _search = TextEditingController();
  Timer? _debounce;
  List<JsonMap> _rows = [];
  int _page = 1, _total = 0, _request = 0;
  bool _loading = true;
  String? _error;
  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final request = ++_request;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final response = await widget.api.get(
        widget.path,
        query: {
          'page': _page,
          'page_size': 20,
          if (widget.searchable && _search.text.trim().isNotEmpty)
            'search': _search.text.trim(),
        },
      );
      if (!mounted || request != _request) return;
      setState(() {
        _rows = objectList(response['items']);
        _total = (response['total'] as num?)?.toInt() ?? _rows.length;
        _loading = false;
      });
    } catch (error) {
      if (mounted && request == _request) {
        setState(() {
          _error = error.toString();
          _loading = false;
        });
      }
    }
  }

  Future<void> _open(Future<bool?> Function() action) async {
    final changed = await action();
    if (!mounted || changed != true) return;
    await _load();
    if (mounted) await widget.onChanged?.call();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(widget.title),
      actions: [
        IconButton(
          tooltip: 'Refresh ${widget.title.toLowerCase()}',
          onPressed: _load,
          icon: const Icon(Icons.refresh_rounded),
        ),
      ],
    ),
    body: SafeArea(
      top: false,
      child: RefreshIndicator(
        onRefresh: _load,
        child: LayoutBuilder(
          builder: (context, constraints) => ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: EdgeInsets.symmetric(
              horizontal: constraints.maxWidth > 928
                  ? (constraints.maxWidth - 880) / 2
                  : 16,
              vertical: 16,
            ),
            children: [
              Text(
                widget.description,
                style: TextStyle(color: context.colors.textSecondary),
              ),
              const SizedBox(height: 20),
              if (widget.onCreate != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: FilledButton.icon(
                      onPressed: () => _open(widget.onCreate!),
                      icon: const Icon(Icons.add_rounded),
                      label: Text(widget.createLabel ?? 'Create'),
                    ),
                  ),
                ),
              if (widget.searchable)
                Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: TextField(
                    controller: _search,
                    decoration: InputDecoration(
                      labelText: 'Search ${widget.title.toLowerCase()}',
                      prefixIcon: const Icon(Icons.search_rounded),
                      suffixIcon: _search.text.isEmpty
                          ? null
                          : IconButton(
                              tooltip: 'Clear search',
                              onPressed: () {
                                _debounce?.cancel();
                                _search.clear();
                                _page = 1;
                                _load();
                              },
                              icon: const Icon(Icons.close_rounded),
                            ),
                    ),
                    onChanged: (_) {
                      _debounce?.cancel();
                      ++_request;
                      setState(() {
                        _loading = true;
                      });
                      _debounce = Timer(const Duration(milliseconds: 350), () {
                        _page = 1;
                        _load();
                      });
                    },
                  ),
                ),
              if (_loading)
                const Padding(
                  padding: EdgeInsets.all(40),
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (_error != null)
                WorkspaceNotice(_error!, error: true, onRetry: _load)
              else ...[
                if (_rows.isEmpty)
                  WorkspaceEmpty(
                    title: 'No ${widget.title.toLowerCase()} found',
                    message: _search.text.isNotEmpty
                        ? 'Try a different search.'
                        : 'New entries will appear here.',
                  )
                else
                  ..._rows.map(
                    (row) => widget.rowBuilder(
                      context,
                      row,
                      widget.onOpen == null
                          ? null
                          : () => _open(() => widget.onOpen!(row)),
                    ),
                  ),
                const SizedBox(height: 8),
                Wrap(
                  alignment: WrapAlignment.spaceBetween,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: 12,
                  runSpacing: 8,
                  children: [
                    Text(
                      '$_total total · Page $_page of ${(_total / 20).ceil().clamp(1, 2147483647)}',
                      style: TextStyle(color: context.colors.textSecondary),
                    ),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        IconButton(
                          tooltip: 'Previous page',
                          onPressed: _page > 1
                              ? () {
                                  _page--;
                                  _load();
                                }
                              : null,
                          icon: const Icon(Icons.chevron_left_rounded),
                        ),
                        IconButton(
                          tooltip: 'Next page',
                          onPressed: _page * 20 < _total
                              ? () {
                                  _page++;
                                  _load();
                                }
                              : null,
                          icon: const Icon(Icons.chevron_right_rounded),
                        ),
                      ],
                    ),
                  ],
                ),
              ],
              const SizedBox(height: 24),
            ],
          ),
        ),
      ),
    ),
  );
}

class WorkspaceDirectoryTile extends StatelessWidget {
  const WorkspaceDirectoryTile({
    super.key,
    required this.title,
    required this.subtitle,
    required this.icon,
    this.status,
    this.onTap,
  });
  final String title, subtitle;
  final String? status;
  final IconData icon;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => Card(
    margin: const EdgeInsets.only(bottom: 10),
    child: InkWell(
      borderRadius: BorderRadius.circular(16),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            CircleAvatar(
              backgroundColor: context.colors.brandSoft,
              foregroundColor: context.colors.brand,
              child: Icon(icon, size: 22),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: Theme.of(context).textTheme.titleSmall),
                  const SizedBox(height: 5),
                  Text(
                    subtitle,
                    style: TextStyle(color: context.colors.textSecondary),
                  ),
                  if (status != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 10),
                      child: WorkspaceStatus(status!),
                    ),
                ],
              ),
            ),
            if (onTap != null)
              const Padding(
                padding: EdgeInsets.only(left: 4),
                child: Icon(Icons.chevron_right_rounded),
              ),
          ],
        ),
      ),
    ),
  );
}
