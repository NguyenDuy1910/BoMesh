import 'package:flutter/material.dart';

Widget googleButton({required VoidCallback onPressed}) => OutlinedButton.icon(
  onPressed: onPressed,
  icon: const Icon(Icons.account_circle_outlined),
  label: const Text('Continue with Google'),
);
