import 'package:flutter/material.dart';

import '../../app/workspace_scope.dart';
import '../../core/api_client.dart';
import '../../ui/ui.dart';
import '../auth/session.dart';
import 'document_feed.dart';
import 'knowledge_models.dart';
import 'knowledge_widgets.dart';
import 'share_sheet.dart';
import 'upload_sheet.dart';

/// A folder you can share: where it sits, what it is for, who can open it,
/// then what is inside.
///
/// Upload is the one big action (with `collection.update`); Share sits beside
/// the people who already have access (with `collection.share`); rename and
/// delete live in "···".
class CollectionPage extends StatefulWidget {
  const CollectionPage({super.key, required this.collection});
  final KnowledgeCollection collection;

  @override
  State<CollectionPage> createState() => _CollectionPageState();
}

class _CollectionPageState extends State<CollectionPage> {
  ApiClient? _api;
  late AuthSession _session;
  late KnowledgeCollection _collection = widget.collection;
  DocumentFeed? _feed;

  /// Every collection this person can read: for the path and what is inside.
  List<KnowledgeCollection> _all = const [];
  List<CollectionGrant>? _grants;
  bool _starting = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final scope = WorkspaceScope.of(context);
    _session = scope.session;
    if (!identical(scope.api, _api)) {
      _api = scope.api;
      _feed?.dispose();
      _feed = DocumentFeed(scope.api, collectionId: _collection.id)..load();
      _loadMeta();
    }
  }

  @override
  void dispose() {
    _feed?.dispose();
    super.dispose();
  }

  ApiClient get _client => _api!;
  DocumentFeed get _documents => _feed!;
  String get _path => '/collections/${Uri.encodeComponent(_collection.id)}';

  bool _allowed(String permission) =>
      allowedOn(_session, _collection, permission);

  Future<void> _loadMeta() async {
    try {
      final all = (await readAllPages(
        _client,
        '/collections',
      )).map(KnowledgeCollection.fromJson).toList();
      if (!mounted) return;
      setState(() {
        _all = all;
        _collection =
            all.where((item) => item.id == _collection.id).firstOrNull ??
            _collection;
      });
    } catch (_) {
      // The path and sub-collections are context; the items still load.
    }
    if (!_allowed('collection.share')) return;
    try {
      final grants = await readGrants(_client, _collection.id);
      if (mounted) setState(() => _grants = grants);
    } catch (_) {
      // The share sheet reports its own failure.
    }
  }

  Future<void> _refresh() =>
      Future.wait([_documents.load(quiet: true), _loadMeta()]);

  List<KnowledgeCollection> get _ancestors {
    final byId = {for (final item in _all) item.id: item};
    final path = <KnowledgeCollection>[];
    final seen = {_collection.id};
    var parent = byId[_collection.parentId];
    while (parent != null && seen.add(parent.id)) {
      path.insert(0, parent);
      parent = byId[parent.parentId];
    }
    return path;
  }

  List<KnowledgeCollection> get _children =>
      _all.where((item) => item.parentId == _collection.id).toList();

  Future<void> _open(KnowledgeCollection collection) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => CollectionPage(collection: collection),
      ),
    );
    if (mounted) await _refresh();
  }

  Future<void> _upload() async {
    if (await showUploadSheet(context, into: _collection) && mounted) {
      await _refresh();
    }
  }

  Future<void> _share() async {
    await showShareSheet(context, _collection);
    if (mounted) await _loadMeta();
  }

  /// One run for the pending and outdated documents of this collection.
  Future<void> _makeSearchable() async {
    if (_starting) return;
    setState(() => _starting = true);
    try {
      final run = await startProcessing(_client, collectionId: _collection.id);
      _documents.follow(run);
      await _documents.load(quiet: true);
    } catch (error) {
      // A 409 explains itself, e.g. nothing is left to make searchable.
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  String get _goneLine {
    final count = _collection.documentCount;
    return count == 1
        ? '1 item stops appearing in answers'
        : '${groupedNumber(count)} items stop appearing in answers';
  }

  Future<void> _more() async {
    final action = await showAppSheet<String>(
      context,
      builder: (sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_allowed('collection.update'))
            SheetOption(
              icon: Icons.edit_outlined,
              title: 'Rename and describe',
              onTap: () => Navigator.pop(sheetContext, 'edit'),
            ),
          if (_allowed('collection.delete'))
            SheetOption(
              icon: Icons.delete_outline_rounded,
              danger: true,
              title: 'Delete collection',
              subtitle: _goneLine,
              onTap: () => Navigator.pop(sheetContext, 'delete'),
            ),
        ],
      ),
    );
    if (!mounted) return;
    switch (action) {
      case 'edit':
        await _edit();
      case 'delete':
        await _delete();
    }
  }

  Future<void> _edit() async {
    final values = await showCollectionForm(
      context,
      title: 'Rename and describe',
      initialTitle: _collection.title,
      initialDescription: _collection.description,
      confirmLabel: 'Save',
    );
    if (values == null || !mounted) return;
    try {
      final updated = await _client.patch(
        _path,
        body: {'title': values.title, 'description': values.description},
      );
      if (!mounted) return;
      setState(() {
        _collection = KnowledgeCollection.fromJson({
          ...updated,
          if (updated['permissions'] is! List)
            'permissions': _collection.permissions.toList(),
        });
      });
    } catch (error) {
      if (mounted) showError(context, error);
    }
  }

  Future<void> _delete() async {
    final confirmed = await confirmAction(
      context,
      title: 'Delete “${_collection.title}”?',
      message: '$_goneLine. This can’t be undone.',
      confirmLabel: 'Delete collection',
      destructive: true,
    );
    if (!confirmed || !mounted) return;
    try {
      await _client.delete(_path);
      if (!mounted) return;
      showToast(context, 'Collection deleted');
      Navigator.of(context).pop();
    } catch (error) {
      if (mounted) showError(context, error);
    }
  }

  @override
  Widget build(BuildContext context) {
    final canUpload = _allowed('collection.update');
    final children = _children;
    return Scaffold(
      appBar: AppHeader(
        actions: [
          if (canUpload || _allowed('collection.delete'))
            IconButton(
              tooltip: 'More',
              onPressed: _more,
              icon: const Icon(Icons.more_horiz_rounded),
            ),
        ],
      ),
      floatingActionButton: canUpload
          ? AppFab(
              icon: Icons.upload_rounded,
              label: 'Upload',
              onPressed: _upload,
            )
          : null,
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: EdgeInsets.fromLTRB(
            16,
            0,
            16,
            canUpload ? kFabClearance : 28,
          ),
          children: [
            _Breadcrumbs(
              path: [
                'Knowledge',
                for (final item in _ancestors) item.title,
                _collection.title,
              ],
            ),
            _hero(),
            if (children.isNotEmpty) ...[
              SectionLabel(
                'Inside',
                aside: countOf(children.length, 'collection'),
              ),
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    for (final child in children) ...[
                      _Chip(label: child.title, onTap: () => _open(child)),
                      const SizedBox(width: 8),
                    ],
                  ],
                ),
              ),
            ],
            ListenableBuilder(
              listenable: _documents,
              builder: (context, _) => Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  ?_searchableNotice(),
                  SectionLabel(
                    'Items',
                    aside: _documents.loading
                        ? null
                        : groupedNumber(_documents.total),
                  ),
                ],
              ),
            ),
            DocumentFeedView(
              feed: _documents,
              empty: EmptyView(
                icon: Icons.insert_drive_file_outlined,
                title: 'Nothing here yet',
                message: canUpload
                    ? 'Upload files to add them to this collection.'
                    : 'Files added to this collection appear here.',
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// One quiet line when some items are not searchable and this person can
  /// make them so.
  Widget? _searchableNotice() {
    final feed = _documents;
    if (feed.loading || feed.error != null || !_allowed('ingestion.run')) {
      return null;
    }
    if (feed.following) {
      return const Padding(
        padding: EdgeInsets.only(top: 16),
        child: InlineNotice(
          icon: Icons.autorenew_rounded,
          text: 'Making them searchable. This list updates as each is done.',
        ),
      );
    }
    final waiting = feed.documents
        .where(
          (document) => document.isProcessable && document.processing.awaitsRun,
        )
        .length;
    if (waiting == 0) return null;
    return Padding(
      padding: const EdgeInsets.only(top: 16),
      child: InlineNotice(
        icon: Icons.auto_awesome_rounded,
        text: feed.hasMore
            ? 'Some items aren’t searchable yet'
            : waiting == 1
            ? '1 item isn’t searchable yet'
            : '${groupedNumber(waiting)} items aren’t searchable yet',
        actionLabel: 'Make searchable',
        onAction: _starting ? null : _makeSearchable,
      ),
    );
  }

  Widget _hero() {
    final colors = context.colors;
    final grants = _grants;
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 12, 4, 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              ToneTile(
                tone: toneFor(_collection.id),
                icon: Icons.menu_book_outlined,
                size: TileSize.large,
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _collection.title,
                      style: TextStyle(
                        color: colors.ink,
                        fontSize: 22,
                        fontWeight: FontWeight.w700,
                        letterSpacing: -0.6,
                        height: 1.2,
                      ),
                    ),
                    const SizedBox(height: 4),
                    CollectionFacts(collection: _collection),
                  ],
                ),
              ),
            ],
          ),
          if (_collection.description.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text(
              _collection.description,
              style: TextStyle(color: colors.ink2, fontSize: 14.5, height: 1.5),
            ),
          ],
          if (_allowed('collection.share')) ...[
            const SizedBox(height: 12),
            Row(
              children: [
                if (grants != null && grants.isNotEmpty) ...[
                  AvatarStack(names: [for (final grant in grants) grant.name]),
                  const SizedBox(width: 10),
                ],
                Expanded(
                  child: Text(
                    grants == null
                        ? ''
                        : grants.isEmpty
                        ? 'Not shared yet'
                        : 'Shared with ${groupedNumber(grants.length)}',
                    style: TextStyle(color: colors.ink3, fontSize: 13),
                  ),
                ),
                FilledButton.icon(
                  style: secondaryButtonStyle(context, small: true),
                  onPressed: _share,
                  icon: const Icon(Icons.person_add_alt_1_outlined, size: 18),
                  label: const Text('Share'),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// Where a collection sits: "Knowledge › Parent › This one".
class _Breadcrumbs extends StatelessWidget {
  const _Breadcrumbs({required this.path});
  final List<String> path;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Text.rich(
        TextSpan(
          children: [
            for (var index = 0; index < path.length; index++) ...[
              if (index > 0)
                WidgetSpan(
                  alignment: PlaceholderAlignment.middle,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 2),
                    child: Icon(
                      Icons.chevron_right_rounded,
                      size: 16,
                      color: colors.ink3,
                    ),
                  ),
                ),
              TextSpan(
                text: path[index],
                style: index == path.length - 1
                    ? TextStyle(color: colors.ink, fontWeight: FontWeight.w700)
                    : null,
              ),
            ],
          ],
        ),
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(color: colors.ink3, fontSize: 13),
      ),
    );
  }
}

/// A sub-collection, as a rounded chip.
class _Chip extends StatelessWidget {
  const _Chip({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Material(
      color: colors.canvas,
      shape: StadiumBorder(side: BorderSide(color: colors.lineStrong)),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 34),
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.menu_book_outlined, size: 15, color: colors.ink2),
              const SizedBox(width: 6),
              Text(
                label,
                style: TextStyle(
                  color: colors.ink2,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
