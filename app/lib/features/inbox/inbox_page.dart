import 'package:flutter/material.dart';

import '../../app/account_sheet.dart';
import '../../app/workspace_scope.dart';
import '../../core/api_client.dart';
import '../../ui/ui.dart';
import '../manage/access/requests_page.dart';
import '../manage/ingestion/connection_flow.dart';
import '../manage/ingestion/source_sheet.dart';
import 'inbox_controller.dart';

class InboxPage extends StatefulWidget {
  const InboxPage({super.key, required this.controller});
  final InboxController controller;
  @override
  State<InboxPage> createState() => _InboxPageState();
}

class _InboxPageState extends State<InboxPage> {
  bool _unreadOnly = false;

  Future<void> _read(InboxItem item, {bool read = true}) async {
    try { await widget.controller.markRead(item, read: read); }
    catch (error) { if (mounted) showError(context, error); }
  }

  Future<void> _open(InboxItem item) async {
    final scope = WorkspaceScope.of(context);
    await _read(item);
    if (!mounted) return;
    switch (item.kind) {
      case InboxKind.request:
        await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => RequestsPage(initialRequestId: textOf(item.resource['id']))));
      case InboxKind.source:
        String title = 'Knowledge';
        try {
          final id = textOf(item.resource['collection_id']);
          if (id.isNotEmpty) title = textOf((await scope.api.get('/collections/${Uri.encodeComponent(id)}'))['title'], title);
        } catch (_) { /* The source remains actionable without its collection title. */ }
        if (!mounted) return;
        await showSourceSheet(context, api: scope.api, source: item.resource,
          collectionTitle: title, canSync: scope.session.can('source.manage'));
      case InboxKind.connection:
        await showConnectionSheet(context, api: scope.api, connection: item.resource);
    }
    if (mounted) await widget.controller.refresh();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      final items = controller.items.where((item) => !_unreadOnly || !controller.isRead(item)).toList();
      return Scaffold(
        backgroundColor: context.colors.paper,
        appBar: AppHeader(paper: true, actions: [
          if (controller.unread > 0) TextButton(
            onPressed: () async {
              try { await controller.markAllRead(); }
              catch (error) { if (context.mounted) showError(context, error); }
            }, child: const Text('Mark all read')),
          const AccountButton(),
        ]),
        body: RefreshIndicator(
          onRefresh: controller.refresh,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(), padding: kPagePadding,
            children: [
              Text('Inbox', style: Theme.of(context).textTheme.headlineMedium),
              const SizedBox(height: 4),
              Text(controller.unread == 0 ? 'Nothing unread' : '${controller.unread} unread', style: Theme.of(context).textTheme.bodySmall),
              const SizedBox(height: 18),
              Segmented<bool>(segments: const {false: 'All', true: 'Unread'}, selected: _unreadOnly,
                onChanged: (value) => setState(() => _unreadOnly = value)),
              const SizedBox(height: 12),
              for (final error in controller.errors) Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: InlineNotice(text: error, tone: StatusTone.danger, actionLabel: 'Retry', onAction: controller.refresh)),
              if (controller.loading) const LoadingView()
              else if (items.isEmpty) EmptyView(
                icon: controller.errors.isEmpty ? Icons.task_alt_rounded : Icons.cloud_off_outlined,
                title: controller.errors.isEmpty ? 'You’re all caught up' : 'Some updates couldn’t load',
                message: controller.errors.isEmpty ? 'Access requests and connected sources that need you appear here.' : 'Retry to check what needs your attention.'),
              if (items.isNotEmpty) ListGroup(children: [
                for (final item in items) Dismissible(
                  key: ValueKey(item.key), direction: DismissDirection.endToStart,
                  confirmDismiss: (_) async { await _read(item, read: !controller.isRead(item)); return false; },
                  background: Container(color: context.colors.brandSoft, alignment: Alignment.centerRight,
                    padding: const EdgeInsets.all(16), child: Text(controller.isRead(item) ? 'Mark unread' : 'Mark read')),
                  child: ListRow(
                    leading: ToneTile(tone: item.kind == InboxKind.request ? Tone.indigo : Tone.danger,
                      icon: item.kind == InboxKind.request ? Icons.person_add_alt_1_outlined : Icons.sync_problem_outlined,
                      size: TileSize.small),
                    title: item.title, subtitle: item.detail,
                    maxSubtitleLines: 3,
                    trailing: !controller.isRead(item) ? Icon(Icons.circle, size: 8, color: context.colors.brand) : null,
                    onTap: () => _open(item),
                    onLongPress: () => _read(item, read: !controller.isRead(item)),
                  ),
                ),
              ]),
              const SizedBox(height: 16),
              Text('Updates from your current access requests and connected sources. Read status is saved on this device; push and email notifications are not available.',
                style: Theme.of(context).textTheme.bodySmall),
            ],
          ),
        ),
      );
    },
  );
}
