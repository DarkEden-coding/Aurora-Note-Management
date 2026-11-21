// Search and trash dialogs opened from the sidebar header, matching the web's LibraryOverlays.
package app.aurora.notes.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.aurora.notes.data.LibraryNote
import app.aurora.notes.data.LibraryTree

private fun LibraryTree.pathOf(note: LibraryNote): String =
    listOfNotNull(
        projects.firstOrNull { it.id == note.projectId }?.name,
        folders.firstOrNull { it.id == note.folderId }?.name,
    ).joinToString(" / ")

@Composable
private fun NoteRow(tree: LibraryTree, note: LibraryNote, onClick: () -> Unit, actions: (@Composable () -> Unit)? = null) {
    TreeItem(selected = false, onClick = onClick, actions = actions) {
        LucideIcon(Lucide.FileText, 16, Neo.muted)
        Label(note.title.ifBlank { "Untitled" }, modifier = Modifier.weight(1f))
        Label(tree.pathOf(note), 12.sp, Neo.muted)
    }
}

@Composable
fun SearchDialog(state: AppState, onDismiss: () -> Unit) {
    var query by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    val tree = state.library
    val results = tree.notes.filter {
        !it.trashed && !it.archived && it.title.ifBlank { "Untitled" }.contains(query.trim(), ignoreCase = true)
    }
    val open = { note: LibraryNote -> state.open(note.id); onDismiss() }
    NeoDialog(onDismiss, top = true) {
        DialogHeader("Library", "Search notes", onDismiss)
        Row(Modifier.fillMaxWidth().well().padding(horizontal = 9.dp).heightIn(min = 42.dp), verticalAlignment = Alignment.CenterVertically) {
            LucideIcon(Lucide.Search, 15, Neo.muted)
            Spacer(Modifier.width(7.dp))
            androidx.compose.foundation.layout.Box(Modifier.weight(1f)) {
                if (query.isEmpty()) Label("Note title", 14.sp, Neo.muted)
                BasicTextField(
                    query, { query = it }, singleLine = true,
                    textStyle = TextStyle(color = Neo.text, fontSize = 14.sp, fontFamily = AuroraFont),
                    cursorBrush = SolidColor(Neo.accent),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { results.firstOrNull()?.let(open) }),
                    modifier = Modifier.fillMaxWidth().focusRequester(focus),
                )
            }
        }
        LazyColumn(Modifier.heightIn(max = 420.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            items(results, key = { it.id }) { note -> NoteRow(tree, note, onClick = { open(note) }) }
        }
        if (results.isEmpty()) Label("No notes match", color = Neo.muted, modifier = Modifier.padding(horizontal = 9.dp))
    }
    LaunchedEffect(Unit) { focus.requestFocus() }
}

@Composable
fun TrashDialog(state: AppState, onDismiss: () -> Unit) {
    var confirm by remember { mutableStateOf<LibraryNote?>(null) }
    val tree = state.library
    val trashed = tree.notes.filter { it.trashed }
    NeoDialog(onDismiss) {
        DialogHeader("Library", "Trash", onDismiss)
        LazyColumn(Modifier.heightIn(max = 420.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            items(trashed, key = { it.id }) { note ->
                NoteRow(tree, note, onClick = {}, actions = {
                    IconButton(Lucide.RotateCcw, 14) { state.launch { state.api.restoreNote(note.id) } }
                    IconButton(Lucide.Trash2, 14, tint = Neo.danger) { confirm = note }
                })
            }
        }
        if (trashed.isEmpty()) Label("Trash is empty", color = Neo.muted, modifier = Modifier.padding(horizontal = 9.dp))
    }
    confirm?.let { note ->
        NeoDialog({ confirm = null }) {
            DialogHeader("Library", "Delete permanently", { confirm = null })
            Label("Delete ${note.title.ifBlank { "Untitled" }}? This can't be undone.", color = Neo.muted)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                NeoButton(fill = Color.Transparent, shadow = false, onClick = { confirm = null }) { Label("Cancel") }
                NeoButton(fill = Neo.danger, onClick = {
                    confirm = null
                    state.launch { state.api.deleteNoteForever(note.id) }
                }) { Label("Delete", color = Neo.accentContrast) }
            }
        }
    }
}
