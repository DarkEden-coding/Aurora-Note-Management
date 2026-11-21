// The library tree's long-press menu, matching the web sidebar's context menu: rename, new note,
// new folder, favorite, and delete or trash, with the rename and delete confirmations.
package app.aurora.notes.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import app.aurora.notes.data.LibraryFolder
import app.aurora.notes.data.LibraryNote
import app.aurora.notes.data.LibraryProject

internal sealed interface MenuTarget {
    data class Project(val item: LibraryProject) : MenuTarget
    data class Folder(val item: LibraryFolder) : MenuTarget
    data class Note(val item: LibraryNote) : MenuTarget
}

private sealed interface Pending {
    data class Rename(val target: MenuTarget, val value: String) : Pending
    data class ConfirmDelete(val target: MenuTarget, val name: String) : Pending
}

/**
 * The menu for [target], opened by a long press on its row. [onNewNote] opens the new-note dialog
 * for a project or folder.
 */
@Composable
internal fun LibraryMenu(
    state: AppState,
    target: MenuTarget,
    onNewNote: (projectId: String, folderId: String?) -> Unit,
    onDismiss: () -> Unit,
) {
    var pending by remember { mutableStateOf<Pending?>(null) }
    val current = pending
    if (current != null) {
        when (current) {
            is Pending.Rename -> RenameDialog(current.value, onDismiss) { name ->
                onDismiss()
                when (val t = current.target) {
                    is MenuTarget.Project -> state.launch { state.api.renameProject(t.item.id, name) }
                    is MenuTarget.Folder -> state.launch { state.api.renameFolder(t.item.id, name) }
                    is MenuTarget.Note -> state.launch { state.api.renameNote(t.item.id, name) }
                }
            }
            is Pending.ConfirmDelete -> ConfirmDeleteDialog(current.target, current.name, onDismiss) {
                onDismiss()
                when (val t = current.target) {
                    is MenuTarget.Project -> state.launch { state.api.deleteProject(t.item.id) }
                    is MenuTarget.Folder -> state.launch { state.api.deleteFolder(t.item.id) }
                    is MenuTarget.Note -> Unit
                }
            }
        }
        return
    }

    Popup(alignment = Alignment.TopStart, offset = IntOffset(0, 0), onDismissRequest = onDismiss, properties = PopupProperties(focusable = true)) {
        Column(Modifier.padding(start = 24.dp, top = 30.dp).width(200.dp).panel(Neo.floating + Neo.outset, 12.dp).padding(5.dp)) {
            when (target) {
                is MenuTarget.Project -> {
                    MenuItem("Rename") { pending = Pending.Rename(target, target.item.name) }
                    MenuItem("New note", Lucide.Plus) { onDismiss(); onNewNote(target.item.id, null) }
                    MenuItem("New folder", Lucide.FolderPlus) { onDismiss(); state.launch { state.api.createFolder(target.item.id, "New folder") } }
                    MenuDivider()
                    MenuItem("Delete", Lucide.Trash2, Neo.danger) { pending = Pending.ConfirmDelete(target, target.item.name) }
                }
                is MenuTarget.Folder -> {
                    MenuItem("Rename") { pending = Pending.Rename(target, target.item.name) }
                    MenuItem("New note", Lucide.Plus) { onDismiss(); onNewNote(target.item.projectId, target.item.id) }
                    MenuItem("New folder", Lucide.FolderPlus) {
                        onDismiss(); state.launch { state.api.createFolder(target.item.projectId, "New folder", target.item.id) }
                    }
                    MenuDivider()
                    MenuItem("Delete", Lucide.Trash2, Neo.danger) { pending = Pending.ConfirmDelete(target, target.item.name) }
                }
                is MenuTarget.Note -> {
                    MenuItem("Rename") { pending = Pending.Rename(target, target.item.title) }
                    MenuItem(if (target.item.favorite) "Remove favorite" else "Add favorite", Lucide.Star) {
                        onDismiss(); state.launch { state.api.setFavorite(target.item.id, !target.item.favorite) }
                    }
                    MenuDivider()
                    MenuItem("Move to trash", Lucide.Trash2, Neo.danger) { onDismiss(); state.launch { state.api.trashNote(target.item.id) } }
                }
            }
        }
    }
}

@Composable
private fun MenuItem(label: String, icon: ImageVector? = null, tint: Color = Neo.text, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 38.dp).clip(RoundedCornerShape(8.dp)).clickable(onClick = onClick).padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (icon != null) LucideIcon(icon, 14, tint) else Spacer(Modifier.width(14.dp))
        Label(label, 13.sp, tint)
    }
}

@Composable
private fun MenuDivider() = Box(Modifier.padding(vertical = 4.dp).fillMaxWidth().height(1.dp).background(Neo.border))

@Composable
private fun RenameDialog(initial: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var name by remember { mutableStateOf(initial) }
    NeoDialog(onDismiss, top = true) {
        DialogHeader("Library", "Rename", onDismiss)
        NeoTextField(name, { name = it }, Modifier.heightIn(min = 42.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            NeoButton(fill = Color.Transparent, shadow = false, onClick = onDismiss) { Label("Cancel") }
            NeoButton(fill = Neo.accent, onClick = { name.trim().takeIf { it.isNotEmpty() }?.let(onSave) }) { Label("Save", color = Neo.accentContrast) }
        }
    }
}

@Composable
private fun ConfirmDeleteDialog(target: MenuTarget, name: String, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    val what = if (target is MenuTarget.Project) "project" else "folder"
    NeoDialog(onDismiss) {
        DialogHeader("Library", "Delete $what?", onDismiss)
        Label("All notes and folders inside “$name” will be deleted permanently.", 13.sp, Neo.muted)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            NeoButton(fill = Color.Transparent, shadow = false, onClick = onDismiss) { Label("Cancel") }
            NeoButton(fill = Neo.danger, onClick = onConfirm) { Label("Delete", color = Neo.accentContrast) }
        }
    }
}
