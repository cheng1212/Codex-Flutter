import 'package:material_ui/material_ui.dart';

import 'core/app_state.dart';
import 'core/settings_store.dart';
import 'core/token_store.dart';
import 'features/pairing/pairing_screen.dart';
import 'features/projects/projects_screen.dart';
import 'features/settings/settings_screen.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final settings = await SettingsStore.load();
  final appState = AppState(settings: settings, tokens: TokenStore());
  await appState.initialise();
  runApp(CodexFlutterApp(appState: appState));
}

class CodexFlutterApp extends StatefulWidget {
  const CodexFlutterApp({super.key, required this.appState});

  final AppState appState;

  @override
  State<CodexFlutterApp> createState() => _CodexFlutterAppState();
}

class _CodexFlutterAppState extends State<CodexFlutterApp> {
  @override
  void initState() {
    super.initState();
    widget.appState.addListener(_onAppStateChanged);
  }

  void _onAppStateChanged() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.appState.removeListener(_onAppStateChanged);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final appState = widget.appState;
    return MaterialApp(
      title: 'Codex Flutter',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
        useMaterial3: true,
      ),
      home: !appState.initialised
          ? const Scaffold(
              body: Center(child: CircularProgressIndicator()),
            )
          : appState.isPaired
              ? ProjectsScreen(appState: appState)
              : PairingScreen(
                  appState: appState,
                  onPaired: () => setState(() {}),
                ),
      routes: {
        '/settings': (_) => SettingsScreen(
              appState: appState,
              onUnpaired: () => setState(() {}),
            ),
      },
    );
  }
}
