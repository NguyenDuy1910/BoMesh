import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/account_sheet.dart';
import '../../app/workspace_scope.dart';
import '../../ui/ui.dart';
import 'history_page.dart';
import 'models/chat_models.dart';
import 'services/chat_service.dart';
import 'services/conversation_store.dart';
import 'state/chat_controller.dart';
import 'widgets/chat_composer.dart';
import 'widgets/chat_sheets.dart';
import 'widgets/message_view.dart';

/// Chat home and the current conversation share one composer.
class ChatPage extends StatefulWidget {
  const ChatPage({
    super.key,
    this.initialDocumentId,
    this.initialDocumentTitle,
    this.initialCollectionId,
    this.initialCollectionTitle,
    this.initialPrompt,
    this.initialConversationId,
  });

  /// Starts a new chat with this document already attached.
  final String? initialDocumentId;
  final String? initialDocumentTitle;
  final String? initialCollectionId;
  final String? initialCollectionTitle;
  final String? initialPrompt;
  final String? initialConversationId;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final _scroll = ScrollController();
  ChatController? _current;

  /// Follow new text only while the reader is at the bottom.
  bool _pinned = true;
  bool _showJump = false;
  bool _followScheduled = false;
  int _lastCount = 0;
  String? _lastConversation;
  bool _wasGenerating = false;

  ChatController get _controller => _current!;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final scope = WorkspaceScope.of(context);
    final current = _current;
    if (current != null &&
        current.api == scope.api &&
        current.session.namespace == scope.session.namespace) {
      return;
    }
    if (current != null) {
      current.removeListener(_onChanged);
      // Children still hold the old controller until the next frame.
      WidgetsBinding.instance.addPostFrameCallback((_) => current.dispose());
    }
    _lastCount = 0;
    _lastConversation = null;
    _wasGenerating = false;
    _current = ChatController(
      ChatService(scope.api),
      ConversationStore(namespace: scope.session.namespace),
      scope.session,
    )..addListener(_onChanged);
    unawaited(
      _controller.initialize(
        documentId: widget.initialDocumentId,
        documentTitle: widget.initialDocumentTitle,
        collectionId: widget.initialCollectionId,
        collectionTitle: widget.initialCollectionTitle,
        prompt: widget.initialPrompt,
        conversationId: widget.initialConversationId,
      ),
    );
  }

  @override
  void didUpdateWidget(covariant ChatPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    final conversationId = widget.initialConversationId;
    if (conversationId != null &&
        conversationId != oldWidget.initialConversationId) {
      unawaited(_controller.selectConversation(conversationId));
      return;
    }
    final id = widget.initialDocumentId;
    if (id != oldWidget.initialDocumentId ||
        widget.initialCollectionId != oldWidget.initialCollectionId ||
        widget.initialPrompt != oldWidget.initialPrompt) {
      unawaited(
        _controller.newChat().then((_) {
          if (mounted && id != null) {
            _controller.referenceDocument(
              id,
              widget.initialDocumentTitle ?? 'Document',
            );
          }
          if (mounted) {
            _controller.applyInitialDraft(
              collectionId: widget.initialCollectionId,
              collectionTitle: widget.initialCollectionTitle,
              prompt: widget.initialPrompt,
            );
          }
        }),
      );
    }
  }

  @override
  void dispose() {
    _current
      ?..removeListener(_onChanged)
      ..dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _onChanged() {
    final controller = _controller;
    final count = controller.messages.length;
    final conversation = controller.activeConversationId;
    final generating = controller.isGenerating;
    if (count != _lastCount) {
      // A question just sent in this chat glides into view; an opened chat
      // starts at its latest message.
      final sent =
          count > _lastCount &&
          _lastCount > 0 &&
          conversation == _lastConversation;
      _pinned = true;
      _follow(animated: sent);
    } else if (_pinned && (generating || _wasGenerating)) {
      // While answering, and once more as it settles (sources, actions or
      // an error appear under the text).
      _follow(animated: false);
    }
    _lastCount = count;
    _lastConversation = conversation;
    _wasGenerating = generating;
  }

  void _follow({required bool animated}) {
    if (_followScheduled) return;
    _followScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _followScheduled = false;
      if (!mounted || !_scroll.hasClients) return;
      final target = _scroll.position.maxScrollExtent;
      if (animated && !MediaQuery.disableAnimationsOf(context)) {
        unawaited(
          _scroll.animateTo(
            target,
            duration: const Duration(milliseconds: 260),
            curve: Curves.easeOutCubic,
          ),
        );
      } else {
        _scroll.jumpTo(target);
      }
    });
  }

  bool _onScroll(ScrollNotification notification) {
    if (notification.depth != 0) return false;
    final metrics = notification.metrics;
    final distance = metrics.maxScrollExtent - metrics.pixels;
    if ((notification is ScrollUpdateNotification &&
            notification.dragDetails != null) ||
        notification is ScrollEndNotification) {
      _pinned = distance < 48;
    }
    final show = distance > 160;
    if (show != _showJump) setState(() => _showJump = show);
    return false;
  }

  void _jumpToLatest() {
    _pinned = true;
    _follow(animated: true);
  }

  Future<void> _openHistory() => Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => HistoryPage(controller: _controller),
    ),
  );

  void _newChat() {
    unawaited(_controller.newChat());
  }

  /// The chat's saved title, or its first question until it is saved.
  String get _title {
    final controller = _controller;
    final saved = controller.conversations
        .where((value) => value.id == controller.activeConversationId)
        .firstOrNull
        ?.title;
    return saved ??
        controller.messages
            .where((message) => message.role == ChatRole.user)
            .firstOrNull
            ?.text ??
        'New chat';
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _controller,
    builder: (context, _) {
      final controller = _controller;
      final home = controller.messages.isEmpty;
      final error = controller.error;
      final pageError =
          error != null &&
          !controller.messages.any((message) => message.turn?.error == error);
      // System back from a conversation returns to Ask home, like the
      // header's back button; from Ask home it leaves the tab as usual.
      return PopScope(
        canPop: home,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) _newChat();
        },
        child: Scaffold(
          appBar: home
              ? AppHeader(
                  title: controller.session.workspaceName,
                  onTitleTap: () => showAccountSheet(context),
                  leading: IconButton(
                    tooltip: 'History',
                    onPressed: _openHistory,
                    icon: const Icon(Icons.notes_rounded),
                  ),
                  actions: [
                    IconButton(
                      tooltip: 'Search',
                      onPressed: WorkspaceScope.of(context).openSearch,
                      icon: const Icon(Icons.search_rounded),
                    ),
                    const AccountButton(),
                  ],
                )
              : AppHeader(
                  title: _title,
                  rule: true,
                  leading: IconButton(
                    tooltip: 'Back',
                    onPressed: _newChat,
                    icon: const Icon(
                      Icons.arrow_back_ios_new_rounded,
                      size: 20,
                    ),
                  ),
                  actions: [
                    IconButton(
                      tooltip: 'New chat',
                      onPressed: _newChat,
                      icon: const Icon(Icons.edit_square, size: 21),
                    ),
                  ],
                ),
          body: Column(
            children: [
              Expanded(
                child: controller.isLoading
                    ? const LoadingView()
                    : home
                    ? _AskHome(controller: controller, onHistory: _openHistory)
                    : _conversation(controller),
              ),
              if (pageError)
                _Notice(
                  child: InlineNotice(
                    text: friendlyError(error),
                    icon: Icons.error_outline_rounded,
                    tone: StatusTone.danger,
                    actionLabel: 'Dismiss',
                    onAction: controller.clearError,
                  ),
                ),
              if (!controller.isLoading && !controller.isConfigured)
                const _Notice(
                  child: InlineNotice(
                    text: 'Your role in this workspace doesn’t include asking questions. Ask an administrator for access.',
                    icon: Icons.lock_outline_rounded,
                    tone: StatusTone.warning,
                  ),
                ),
              ChatComposer(
                controller: controller,
                hint: home ? 'Ask anything…' : 'Ask a follow-up…',
                showScope: true,
              ),
            ],
          ),
        ),
      );
    },
  );

  Widget _conversation(ChatController controller) {
    final messages = controller.messages;
    return Stack(
      children: [
        NotificationListener<ScrollNotification>(
          onNotification: _onScroll,
          child: ListView.builder(
            controller: _scroll,
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
            itemCount: messages.length,
            itemBuilder: (context, index) {
              final message = messages[index];
              final question = message.role == ChatRole.assistant
                  ? messages
                            .take(index)
                            .where((value) => value.role == ChatRole.user)
                            .lastOrNull
                            ?.text ??
                        ''
                  : '';
              return Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 720),
                  child: ChatMessageView(
                    key: ValueKey(message.id),
                    message: message,
                    controller: controller,
                    question: question,
                    isStreaming:
                        index == messages.length - 1 &&
                        message.role == ChatRole.assistant &&
                        controller.isGenerating,
                  ),
                ),
              );
            },
          ),
        ),
        if (_showJump)
          Positioned(
            left: 0,
            right: 0,
            bottom: 10,
            child: Center(
              child: Material(
                color: context.colors.canvas,
                shape: CircleBorder(
                  side: BorderSide(color: context.colors.line),
                ),
                elevation: 2,
                shadowColor: context.colors.ink.withValues(alpha: 0.2),
                child: IconButton(
                  tooltip: 'Jump to latest',
                  onPressed: _jumpToLatest,
                  icon: Icon(
                    Icons.arrow_downward_rounded,
                    size: 20,
                    color: context.colors.ink2,
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(12, 4, 12, 0),
    child: Center(
      heightFactor: 1,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 720),
        child: child,
      ),
    ),
  );
}

/// Three honest ways to start, followed by device-local recent chats.
class _AskHome extends StatelessWidget {
  const _AskHome({required this.controller, required this.onHistory});
  final ChatController controller;
  final VoidCallback onHistory;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final enabled = controller.isConfigured;
    final recent = [...controller.conversations]
      ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return ListView(
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
      children: [
        Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 720),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(4, 18, 4, 18),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Hello, ${accountName(controller.session).split(' ').first}',
                        style: TextStyle(color: colors.ink3, fontSize: 13),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'What can I help you find?',
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'Answers come from documents you’re allowed to read, with their sources.',
                        style: TextStyle(
                          color: colors.ink2,
                          fontSize: 15,
                          height: 1.5,
                        ),
                      ),
                    ],
                  ),
                ),
                _Suggestion(
                  tone: Tone.violet,
                  icon: Icons.search_rounded,
                  label: 'Find a document, form or announcement',
                  onTap: enabled ? () => controller.setDraft('Find ') : null,
                ),
                const SizedBox(height: 8),
                _Suggestion(
                  tone: Tone.sheet,
                  icon: Icons.table_chart_outlined,
                  label: 'Analyse a spreadsheet',
                  onTap: enabled
                      ? () => openAttachSheet(context, controller)
                      : null,
                ),
                const SizedBox(height: 8),
                _Suggestion(
                  tone: Tone.sky,
                  icon: Icons.description_outlined,
                  label: 'Draft a brief from your knowledge',
                  onTap: enabled
                      ? () => controller.setDraft(
                          'Draft a brief about … using the sources you can find.',
                        )
                      : null,
                ),
                if (recent.isNotEmpty) ...[
                  SectionLabel(
                    'Recent',
                    actionLabel: 'See all',
                    onAction: onHistory,
                  ),
                  ListGroup(
                    inset: 14,
                    children: [
                      for (final conversation in recent.take(3))
                        ListRow(
                          title: conversation.title,
                          subtitle: [
                            chatDayLabel(conversation.updatedAt),
                            if (conversation.fileCount > 0)
                              countOf(conversation.fileCount, 'file'),
                          ].join(' · '),
                          onTap: () => unawaited(
                            controller.selectConversation(conversation.id),
                          ),
                        ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _Suggestion extends StatelessWidget {
  const _Suggestion({
    required this.tone,
    required this.icon,
    required this.label,
    required this.onTap,
  });
  final Tone tone;
  final IconData icon;
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Material(
      color: colors.subtle,
      borderRadius: BorderRadius.circular(14),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 56),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              children: [
                ToneTile(tone: tone, icon: icon, size: TileSize.small),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    label,
                    style: TextStyle(
                      color: onTap == null ? colors.ink3 : colors.ink,
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
