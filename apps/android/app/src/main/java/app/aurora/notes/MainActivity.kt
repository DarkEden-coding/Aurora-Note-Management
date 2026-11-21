package app.aurora.notes

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import app.aurora.notes.ui.AppState
import app.aurora.notes.ui.AuroraApp
import app.aurora.notes.ui.Neo

class MainActivity : ComponentActivity() {
    private lateinit var state: AppState

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        state = AppState(applicationContext)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = Neo.accent, surface = Neo.surface, background = Neo.bg)) {
                AuroraApp(state)
            }
        }
    }

    override fun onStart() {
        super.onStart()
        state.sync.start()
    }

    override fun onStop() {
        state.flushCamera()
        state.sync.stop()
        super.onStop()
    }
}
