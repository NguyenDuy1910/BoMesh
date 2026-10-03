import 'package:flutter/material.dart';

import '../../../app/app_theme.dart';
import 'product_mark.dart';

/// An empty conversation: one line of purpose and a few questions to start
/// from. Everything else is the composer's job.
class WelcomeView extends StatelessWidget {
  const WelcomeView({super.key, required this.onSelect});

  final ValueChanged<String> onSelect;

  static const _starters = [
    'Summarize the latest updates with sources',
    'What does our policy say about leave?',
    'Find the documents about onboarding',
  ];

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const ProductMark(size: 44),
              const SizedBox(height: 16),
              Text(
                'Ask about your documents',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 6),
              Text(
                'Answers cite the sources you can access.',
                textAlign: TextAlign.center,
                style: TextStyle(color: colors.textSecondary),
              ),
              const SizedBox(height: 24),
              for (final starter in _starters)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: SizedBox(
                    width: double.infinity,
                    child: OutlinedButton(
                      style: OutlinedButton.styleFrom(
                        alignment: Alignment.centerLeft,
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                        foregroundColor: colors.textPrimary,
                      ),
                      onPressed: () => onSelect(starter),
                      child: Text(starter),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
