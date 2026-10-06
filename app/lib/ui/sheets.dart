import 'package:flutter/material.dart';

import '../app/app_theme.dart';
import 'layout.dart';
import 'marks.dart';

/// Opens a bottom sheet over the whole app (above the tab bar).
///
/// Every choice, picker, small form and confirmation in the app is a sheet:
/// a grabber, an optional [title] and [subtitle], the [builder]'s body, and
/// the sheet pops with its result.
Future<T?> showAppSheet<T>(
  BuildContext context, {
  String? title,
  String? subtitle,
  required WidgetBuilder builder,
  bool scrollable = false,
}) => showModalBottomSheet<T>(
  context: context,
  useRootNavigator: true,
  useSafeArea: true,
  isScrollControlled: true,
  showDragHandle: true,
  builder: (sheetContext) {
    final body = Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.viewInsetsOf(sheetContext).bottom,
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (title != null) SheetHeader(title: title, subtitle: subtitle),
              if (scrollable)
                Flexible(
                  child: SingleChildScrollView(child: builder(sheetContext)),
                )
              else
                Flexible(child: builder(sheetContext)),
            ],
          ),
        ),
      ),
    );
    return ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(sheetContext).height * 0.88,
      ),
      child: body,
    );
  },
);

class SheetHeader extends StatelessWidget {
  const SheetHeader({super.key, required this.title, this.subtitle});
  final String title;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 0, 4, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: TextStyle(
              color: colors.ink,
              fontSize: 18,
              fontWeight: FontWeight.w700,
              letterSpacing: -0.3,
            ),
          ),
          if (subtitle != null) ...[
            const SizedBox(height: 3),
            Text(
              subtitle!,
              style: TextStyle(color: colors.ink3, fontSize: 13.5, height: 1.4),
            ),
          ],
        ],
      ),
    );
  }
}

/// One choice in a sheet: a tone tile, a title and an explanation.
///
/// [selected] draws a radio on the right, for single-choice pickers;
/// [danger] colours the title for destructive choices.
class SheetOption extends StatelessWidget {
  const SheetOption({
    super.key,
    required this.icon,
    required this.title,
    this.subtitle,
    this.tone = Tone.slate,
    this.danger = false,
    this.selected,
    this.onTap,
    this.trailing,
  });
  final IconData icon;
  final String title;
  final String? subtitle;
  final Tone tone;
  final bool danger;
  final bool? selected;
  final VoidCallback? onTap;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Semantics(
      selected: selected,
      button: true,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 60),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
            child: Row(
              children: [
                ToneTile(
                  tone: danger ? Tone.danger : tone,
                  icon: icon,
                  size: TileSize.small,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        title,
                        style: TextStyle(
                          color: danger ? colors.danger : colors.ink,
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      if (subtitle != null) ...[
                        const SizedBox(height: 2),
                        Text(
                          subtitle!,
                          style: TextStyle(color: colors.ink3, fontSize: 13),
                        ),
                      ],
                    ],
                  ),
                ),
                ?trailing,
                if (selected != null) ...[
                  const SizedBox(width: 10),
                  _Radio(on: selected!),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Radio extends StatelessWidget {
  const _Radio({required this.on});
  final bool on;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return AnimatedContainer(
      duration: const Duration(milliseconds: 140),
      width: 22,
      height: 22,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(
          color: on ? colors.brand : colors.lineStrong,
          width: on ? 7 : 2,
        ),
      ),
    );
  }
}

/// A labelled value that opens a picker ("Add to · Policies ▾"), or a
/// setting with a switch.
class SelectRow extends StatelessWidget {
  const SelectRow({
    super.key,
    required this.label,
    required this.value,
    this.icon,
    this.tone = Tone.indigo,
    this.onTap,
    this.trailing,
  });

  /// The small label above the value; null for a single-line row.
  final String? label;
  final String value;
  final IconData? icon;
  final Tone tone;
  final VoidCallback? onTap;

  /// Defaults to a dropdown chevron when [onTap] is set.
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Material(
      color: colors.subtle,
      borderRadius: BorderRadius.circular(14),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
          child: Row(
            children: [
              if (icon != null) ...[
                ToneTile(tone: tone, icon: icon!, size: TileSize.small),
                const SizedBox(width: 12),
              ],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (label != null)
                      Text(
                        label!,
                        style: TextStyle(color: colors.ink3, fontSize: 12.5),
                      ),
                    Text(
                      value,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: colors.ink,
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
              trailing ??
                  (onTap != null
                      ? Icon(
                          Icons.expand_more_rounded,
                          color: colors.ink3,
                          size: 22,
                        )
                      : const SizedBox.shrink()),
            ],
          ),
        ),
      ),
    );
  }
}

/// Ask before something that cannot be undone or that affects other people.
///
/// The confirmation is a sheet: what will happen, then the action (in red
/// when [destructive]) above Cancel. Resolves true only on confirm.
Future<bool> confirmAction(
  BuildContext context, {
  required String title,
  required String message,
  required String confirmLabel,
  bool destructive = false,
}) async {
  final result = await showAppSheet<bool>(
    context,
    title: title,
    subtitle: message,
    builder: (sheetContext) => Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          FilledButton(
            style: destructive
                ? FilledButton.styleFrom(
                    backgroundColor: sheetContext.colors.danger,
                    foregroundColor: Colors.white,
                  )
                : null,
            onPressed: () => Navigator.pop(sheetContext, true),
            child: Text(confirmLabel),
          ),
          const SizedBox(height: 8),
          FilledButton(
            style: secondaryButtonStyle(sheetContext),
            onPressed: () => Navigator.pop(sheetContext, false),
            child: const Text('Cancel'),
          ),
        ],
      ),
    ),
  );
  return result ?? false;
}

/// Ask for one line (or a few lines) of text: rename, describe, a note.
/// Resolves to the trimmed text, or null when dismissed.
Future<String?> promptText(
  BuildContext context, {
  required String title,
  String? subtitle,
  String initial = '',
  String hint = '',
  required String confirmLabel,
  bool allowEmpty = false,
  int maxLines = 1,
}) => showAppSheet<String>(
  context,
  title: title,
  subtitle: subtitle,
  builder: (_) => _PromptBody(
    initial: initial,
    hint: hint,
    confirmLabel: confirmLabel,
    allowEmpty: allowEmpty,
    maxLines: maxLines,
  ),
);

class _PromptBody extends StatefulWidget {
  const _PromptBody({
    required this.initial,
    required this.hint,
    required this.confirmLabel,
    required this.allowEmpty,
    required this.maxLines,
  });
  final String initial, hint, confirmLabel;
  final bool allowEmpty;
  final int maxLines;

  @override
  State<_PromptBody> createState() => _PromptBodyState();
}

class _PromptBodyState extends State<_PromptBody> {
  late final _controller = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  bool get _valid => widget.allowEmpty || _controller.text.trim().isNotEmpty;

  void _submit() {
    if (_valid) Navigator.pop(context, _controller.text.trim());
  }

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      TextField(
        controller: _controller,
        autofocus: true,
        maxLines: widget.maxLines,
        minLines: 1,
        textInputAction: widget.maxLines == 1
            ? TextInputAction.done
            : TextInputAction.newline,
        decoration: InputDecoration(hintText: widget.hint),
        onChanged: (_) => setState(() {}),
        onSubmitted: (_) => _submit(),
      ),
      const SizedBox(height: 12),
      FilledButton(
        onPressed: _valid ? _submit : null,
        child: Text(widget.confirmLabel),
      ),
    ],
  );
}
