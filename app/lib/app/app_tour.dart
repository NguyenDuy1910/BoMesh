import 'package:flutter/material.dart';

import '../ui/ui.dart';

Future<void> showAppTour(BuildContext context) => showAppSheet<void>(
  context,
  title: 'A quick look around',
  scrollable: true,
  builder: (_) => const _Tour(),
);

class _Tour extends StatefulWidget {
  const _Tour();
  @override
  State<_Tour> createState() => _TourState();
}

class _TourState extends State<_Tour> {
  int _step = 0;
  static const _tips = [
    (Icons.chat_bubble_outline_rounded, 'Ask in your own words', 'Start in Chat. Answers use the knowledge you can access, with citations you can open.'),
    (Icons.layers_outlined, 'Choose what to search', 'Use the scope chip in the composer to choose knowledge bases. The plus button adds files to your question.'),
    (Icons.format_quote_rounded, 'Trace an answer to its source', 'Amber citations open source passages. Open the document to read the passage in context.'),
    (Icons.menu_book_outlined, 'Keep knowledge together', 'Knowledge brings My files and shared knowledge bases into one place. Open a base to read, add or manage content according to your access.'),
    (Icons.inbox_outlined, 'Know what needs you', 'Inbox links requests and source problems to the place you can act. Search and Account are in the header; admins also have Manage.'),
  ];

  @override
  Widget build(BuildContext context) {
    final (icon, title, detail) = _tips[_step];
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Align(alignment: Alignment.centerLeft, child: ToneTile(tone: Tone.indigo, icon: icon)),
      const SizedBox(height: 18),
      Text(title, style: Theme.of(context).textTheme.titleLarge),
      const SizedBox(height: 10),
      Text(detail, style: Theme.of(context).textTheme.bodyMedium),
      const SizedBox(height: 24),
      Row(children: [
        Text('${_step + 1} of ${_tips.length}', style: Theme.of(context).textTheme.bodySmall),
        const Spacer(),
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Skip')),
        if (_step > 0) IconButton(tooltip: 'Previous tip', onPressed: () => setState(() => _step--), icon: const Icon(Icons.chevron_left)),
        FilledButton(onPressed: () {
          if (_step == _tips.length - 1) { Navigator.pop(context); }
          else { setState(() => _step++); }
        }, child: Text(_step == _tips.length - 1 ? 'Done' : 'Next')),
      ]),
    ]);
  }
}
