import 'dart:async';

import 'package:flutter/material.dart';

import '../../ui/ui.dart';
import 'models/chat_models.dart';
import 'state/chat_controller.dart';

/// "Today", "Yesterday", a weekday within the week, or the date.
String chatDayLabel(DateTime time, {DateTime? now}) {
  final current = now ?? DateTime.now();
  final days = DateTime(
    current.year,
    current.month,
    current.day,
  ).difference(DateTime(time.year, time.month, time.day)).inDays;
  if (days <= 0) return 'Today';
  if (days == 1) return 'Yesterday';
  if (days < 7) return _weekdays[time.weekday - 1];
  return calendarDate(time, now: current);
}

const _weekdays = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

/// Every conversation on this phone: search first, then pinned and recent.
/// Row actions are a long-press or "···".
class HistoryPage extends StatefulWidget {
  const HistoryPage({super.key, required this.controller});
  final ChatController controller;

  @override
  State<HistoryPage> createState() => _HistoryPageState();
}

class _HistoryPageState extends State<HistoryPage> {
  String _query = '';
  Set<String>? _matches;
  int _searchRequest = 0;

  ChatController get _controller => widget.controller;

  /// Titles match at once; message text and file names once the saved
  /// conversations have been read.
  Future<void> _search(String value) async {
    final request = ++_searchRequest;
    setState(() {
      _query = value;
      _matches = null;
    });
    if (value.trim().isEmpty) return;
    try {
      final matches = await _controller.searchConversations(value);
      if (mounted && request == _searchRequest) {
        setState(() => _matches = matches);
      }
    } catch (cause) {
      if (mounted) showError(context, cause);
    }
  }

  void _open(ChatConversation conversation) {
    unawaited(_controller.selectConversation(conversation.id));
    Navigator.of(context).popUntil((route) => route.isFirst);
  }

  void _newChat() {
    unawaited(_controller.newChat());
    Navigator.of(context).popUntil((route) => route.isFirst);
  }

  Future<void> _actions(ChatConversation conversation) async {
    final action = await showAppSheet<_ChatAction>(
      context,
      builder: (sheet) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SheetOption(
            icon: Icons.edit_outlined,
            title: 'Rename',
            onTap: () => Navigator.pop(sheet, _ChatAction.rename),
          ),
          SheetOption(
            icon: Icons.push_pin_outlined,
            title: conversation.pinned ? 'Unpin' : 'Pin',
            onTap: () => Navigator.pop(sheet, _ChatAction.pin),
          ),
          SheetOption(
            icon: Icons.delete_outline_rounded,
            title: 'Delete',
            subtitle: 'Files you referenced stay in Knowledge',
            danger: true,
            onTap: () => Navigator.pop(sheet, _ChatAction.delete),
          ),
        ],
      ),
    );
    if (!mounted || action == null) return;
    switch (action) {
      case _ChatAction.rename:
        final title = await promptText(
          context,
          title: 'Rename chat',
          initial: conversation.title,
          hint: 'Chat name',
          confirmLabel: 'Save',
        );
        if (title != null) {
          await _controller.renameConversation(conversation.id, title);
        }
      case _ChatAction.pin:
        await _controller.pinConversation(conversation);
      case _ChatAction.delete:
        final confirmed = await confirmAction(
          context,
          title: 'Delete this chat?',
          message:
              '“${conversation.title}” is removed from this device. Files uploaded only for it are deleted; files you referenced stay in Knowledge.',
          confirmLabel: 'Delete chat',
          destructive: true,
        );
        if (confirmed) await _controller.deleteConversation(conversation.id);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _controller,
    builder: (context, _) {
      final needle = _query.trim().toLowerCase();
      final all = _controller.conversations;
      final shown = all
          .where(
            (value) =>
                needle.isEmpty ||
                value.title.toLowerCase().contains(needle) ||
                (_matches?.contains(value.id) ?? false),
          )
          .toList();
      final Widget content;
      if (_controller.isLoading) {
        content = const LoadingView();
      } else if (all.isEmpty) {
        content = EmptyView(
          icon: Icons.forum_outlined,
          title: 'No chats yet',
          message: 'Questions you ask are kept here, on this phone.',
          actionLabel: 'Ask a question',
          onAction: _newChat,
        );
      } else if (shown.isEmpty) {
        content = EmptyView(
          icon: Icons.search_off_rounded,
          title: 'No chats match “${_query.trim()}”',
          message: 'Try a word from the question or a file name.',
        );
      } else {
        final sections = _sections(shown);
        content = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (var index = 0; index < sections.length; index++) ...[
              SectionLabel(sections[index].$1, first: index == 0),
              ListGroup(
                inset: 14,
                children: [
                  for (final conversation in sections[index].$2)
                    _row(conversation),
                ],
              ),
            ],
          ],
        );
      }
      return Scaffold(
        appBar: AppHeader(
          title: 'Chats',
          subtitle: 'Saved on this device',
          actions: [
            IconButton(
              tooltip: 'New chat',
              onPressed: _newChat,
              icon: const Icon(Icons.edit_square, size: 21),
            ),
          ],
        ),
        body: ListView(
          padding: kPagePadding,
          children: [
            AppSearchField(hint: 'Search chats', onChanged: _search),
            if (_controller.error case final error?)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: InlineNotice(
                  text: friendlyError(error),
                  icon: Icons.error_outline_rounded,
                  tone: StatusTone.danger,
                  actionLabel: 'Dismiss',
                  onAction: _controller.clearError,
                ),
              ),
            const SizedBox(height: 8),
            content,
          ],
        ),
      );
    },
  );

  Widget _row(ChatConversation conversation) {
    final colors = context.colors;
    return ListRow(
      title: conversation.title,
      subtitle: [
        if (conversation.fileCount > 0) countOf(conversation.fileCount, 'file'),
        clockOrRelative(conversation.updatedAt),
      ].join(' · '),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (conversation.pinned)
            Icon(Icons.push_pin_outlined, size: 16, color: colors.ink3),
          IconButton(
            tooltip: 'Chat actions',
            onPressed: () => _actions(conversation),
            icon: Icon(Icons.more_horiz_rounded, color: colors.ink3),
          ),
        ],
      ),
      onTap: () => _open(conversation),
      onLongPress: () => _actions(conversation),
    );
  }
}

enum _ChatAction { rename, pin, delete }

/// Pinned first, then by when each chat was last used.
List<(String, List<ChatConversation>)> _sections(
  List<ChatConversation> values,
) {
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final yesterday = today.subtract(const Duration(days: 1));
  final week = today.subtract(const Duration(days: 6));
  final groups = <String, List<ChatConversation>>{
    'Pinned': [],
    'Today': [],
    'Yesterday': [],
    'This week': [],
    'Earlier': [],
  };
  for (final value in values) {
    final time = value.updatedAt;
    final key = value.pinned
        ? 'Pinned'
        : !time.isBefore(today)
        ? 'Today'
        : !time.isBefore(yesterday)
        ? 'Yesterday'
        : !time.isBefore(week)
        ? 'This week'
        : 'Earlier';
    groups[key]!.add(value);
  }
  for (final group in groups.values) {
    group.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
  }
  return [
    for (final entry in groups.entries)
      if (entry.value.isNotEmpty) (entry.key, entry.value),
  ];
}
