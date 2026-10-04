package com.nimbalyst.app.screenshots

import androidx.compose.runtime.Composable
import com.nimbalyst.app.ui.NimbalystAndroidApp
import com.nimbalyst.app.ui.PairingScreen
import com.nimbalyst.app.ui.ProjectListScreen
import com.nimbalyst.app.ui.SessionDetailScreen
import com.nimbalyst.app.ui.SessionListScreen
import com.nimbalyst.app.ui.SettingsScreen

/**
 * Renders one screen in isolation for a screenshot capture, bypassing the
 * pairing/login gate in NimbalystAndroidApp.
 */
@Composable
fun ScreenshotHost(screen: ScreenshotScreen) {
    when (screen) {
        ScreenshotScreen.PROJECTS -> ProjectListScreen(onOpenProject = {}, onOpenSettings = {})

        ScreenshotScreen.SESSIONS -> SessionListScreen(
            projectId = ScreenshotDemoData.SHOWCASE_PROJECT_ID,
            projectName = ScreenshotDemoData.SHOWCASE_PROJECT_NAME,
            selectedSessionId = null,
            onSelectSession = {},
            onBack = {}
        )

        ScreenshotScreen.DETAIL, ScreenshotScreen.COMPOSER -> SessionDetailScreen(
            sessionId = ScreenshotDemoData.SHOWCASE_SESSION_ID,
            onBack = {}
        )

        ScreenshotScreen.SETTINGS -> SettingsScreen(
            onBack = {},
            onSignOut = {},
            onUnpair = {},
            onAccountDeleted = {}
        )

        ScreenshotScreen.PAIRING -> PairingScreen(onPaired = {})

        // The demo credentials make this land straight in the main app, so the
        // video walkthrough gets real navigation instead of an isolated screen.
        ScreenshotScreen.WALKTHROUGH -> NimbalystAndroidApp()
    }
}
