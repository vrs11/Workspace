//! Windows filesystem operations rooted in live directory handles.
//! No path concatenation, delete-then-write, or metadata-ignore fallback.
#![cfg(windows)]
use crate::error::{AppError, Result};
use cap_std::fs::Dir;
use std::{
    fs::File,
    io::{Read, Write},
    mem::{offset_of, size_of},
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Component, Path},
    ptr,
};
use windows_sys::{
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            FILE_CREATE, FILE_DIRECTORY_FILE, FILE_EA_INFORMATION, FILE_NON_DIRECTORY_FILE,
            FILE_OPEN, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT, FileEaInformation,
            NtCreateFile, NtQueryInformationFile,
        },
    },
    Win32::{
        Foundation::{
            ERROR_FILE_NOT_FOUND, ERROR_HANDLE_EOF, ERROR_NOT_FOUND, HANDLE, LocalFree,
            RtlNtStatusToDosError, UNICODE_STRING,
        },
        Security::{
            ACL,
            Authorization::{GetSecurityInfo, SE_FILE_OBJECT, SetSecurityInfo},
            DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION, GetSecurityDescriptorControl,
            OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
            PSID, SE_DACL_PROTECTED, UNPROTECTED_DACL_SECURITY_INFORMATION,
        },
        Storage::FileSystem::*,
        System::{
            IO::{DeviceIoControl, IO_STATUS_BLOCK},
            Ioctl::{
                FSCTL_GET_OBJECT_ID, FSCTL_READ_FILE_USN_DATA, READ_FILE_USN_DATA, USN_RECORD_V2,
            },
        },
    },
};
const LIMIT: u64 = 20 * 1024 * 1024;
const SHARED: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
const SYNC: u32 = 0x00100000;
const WRITE_DAC: u32 = 0x00040000;
const WRITE_OWNER: u32 = 0x00080000;
const DELETE_ACCESS: u32 = 0x00010000;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Identity {
    pub volume: u64,
    pub id: [u8; 16],
}
fn handle(file: &impl AsRawHandle) -> HANDLE {
    file.as_raw_handle() as HANDLE
}
fn last_error() -> AppError {
    std::io::Error::last_os_error().into()
}
fn unsupported(message: &str) -> AppError {
    AppError::new("unsupported", message)
}
fn nt_result(status: i32) -> Result<()> {
    if status < 0 {
        // SAFETY: converts an NTSTATUS value; no pointers/ownership involved.
        Err(
            std::io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) } as i32)
                .into(),
        )
    } else {
        Ok(())
    }
}
fn leaf_name(path: &Path) -> Result<Vec<u16>> {
    let mut parts = path.components();
    if !matches!(parts.next(), Some(Component::Normal(_))) || parts.next().is_some() {
        return Err(AppError::new(
            "unsafePath",
            "A single relative Windows name is required",
        ));
    }
    let name: Vec<u16> = path.as_os_str().encode_wide().collect();
    if name.is_empty()
        || name.len() > 255
        || name
            .iter()
            .any(|c| [0, b'/' as u16, b'\\' as u16, b':' as u16].contains(c))
    {
        return Err(AppError::new("unsafePath", "Unsupported Windows file name"));
    }
    Ok(name)
}
fn open(parent: &Dir, leaf: &Path, access: u32, create: bool, directory: bool) -> Result<File> {
    open_shared(parent, leaf, access, create, directory, SHARED)
}
fn open_shared(
    parent: &Dir,
    leaf: &Path,
    access: u32,
    create: bool,
    directory: bool,
    share: u32,
) -> Result<File> {
    let mut name = leaf_name(leaf)?;
    let unicode = UNICODE_STRING {
        Length: (name.len() * 2) as u16,
        MaximumLength: (name.len() * 2) as u16,
        Buffer: name.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: handle(parent),
        ObjectName: &unicode,
        Attributes: 0x40,
        ..Default::default()
    };
    let mut result = ptr::null_mut();
    let mut status = IO_STATUS_BLOCK::default();
    // SAFETY: every pointer refers to a live, correctly sized local; names are
    // single UTF-16 components and the root is the authorized live directory.
    nt_result(unsafe {
        NtCreateFile(
            &mut result,
            access | SYNC,
            &attributes,
            &mut status,
            ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            share,
            if create { FILE_CREATE } else { FILE_OPEN },
            FILE_OPEN_REPARSE_POINT
                | FILE_SYNCHRONOUS_IO_NONALERT
                | if directory {
                    FILE_DIRECTORY_FILE
                } else {
                    FILE_NON_DIRECTORY_FILE
                },
            ptr::null(),
            0,
        )
    })?;
    // SAFETY: successful NtCreateFile transfers exactly one owned handle.
    let file = unsafe { File::from_raw_handle(result) };
    let basic: FILE_ATTRIBUTE_TAG_INFO = info(&file, FileAttributeTagInfo)?;
    if basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(AppError::new(
            "unsafePath",
            "Windows reparse points cannot be traversed",
        ));
    }
    Ok(file)
}
pub fn open_directory(parent: &Dir, leaf: &Path) -> Result<Dir> {
    open(
        parent,
        leaf,
        FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
        false,
        true,
    )
    .map(Dir::from_std_file)
}
pub fn open_read(parent: &Dir, leaf: &Path) -> Result<File> {
    open(parent, leaf, FILE_GENERIC_READ, false, false)
}
pub fn create(parent: &Dir, leaf: &Path, directory: bool) -> Result<()> {
    let file = open(
        parent,
        leaf,
        if directory {
            FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES
        } else {
            FILE_GENERIC_READ | FILE_GENERIC_WRITE
        },
        true,
        directory,
    )?;
    if !directory {
        file.sync_all()?;
    }
    Ok(())
}
/// Enumerate the live directory, without reconstructing its absolute path.
pub fn entries(
    parent: &Dir,
    limit: usize,
) -> Result<(Vec<(std::ffi::OsString, &'static str)>, bool)> {
    let mut storage = vec![0u64; 8192];
    let mut result = Vec::new();
    let mut restart = true;
    loop {
        storage.fill(0);
        let ok = unsafe {
            GetFileInformationByHandleEx(
                handle(parent),
                if restart {
                    FileIdBothDirectoryRestartInfo
                } else {
                    FileIdBothDirectoryInfo
                },
                storage.as_mut_ptr().cast(),
                (storage.len() * 8) as u32,
            )
        };
        if ok == 0 {
            let error = std::io::Error::last_os_error();
            return if error.raw_os_error()
                == Some(windows_sys::Win32::Foundation::ERROR_NO_MORE_FILES as i32)
            {
                Ok((result, false))
            } else {
                Err(error.into())
            };
        }
        restart = false;
        let capacity = storage.len() * 8;
        let header = offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
        let mut offset = 0;
        loop {
            if offset % 8 != 0 || offset + size_of::<FILE_ID_BOTH_DIR_INFO>() > capacity {
                return Err(unsupported("Malformed Windows directory metadata"));
            }
            let record = unsafe {
                &*storage
                    .as_ptr()
                    .cast::<u8>()
                    .add(offset)
                    .cast::<FILE_ID_BOTH_DIR_INFO>()
            };
            let length = record.FileNameLength as usize;
            let next = record.NextEntryOffset as usize;
            if length == 0
                || length % 2 != 0
                || length > capacity - offset - header
                || (next != 0 && (next < header + length || next > capacity - offset))
            {
                return Err(unsupported("Malformed Windows directory name"));
            }
            let name = std::ffi::OsString::from_wide(unsafe {
                std::slice::from_raw_parts(ptr::addr_of!(record.FileName).cast::<u16>(), length / 2)
            });
            if name != "." && name != ".." && !name.to_string_lossy().eq_ignore_ascii_case(".git") {
                if result.len() >= limit {
                    return Ok((result, true));
                }
                let kind = if record.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    "link"
                } else if record.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
                    "directory"
                } else {
                    "file"
                };
                result.push((name, kind));
            }
            if next == 0 {
                break;
            }
            offset += next;
        }
    }
}
pub fn remove_empty_directory(parent: &Dir, leaf: &Path) -> Result<()> {
    let file = open_shared(
        parent,
        leaf,
        DELETE_ACCESS | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
        false,
        true,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
    )?;
    // The kernel refuses nonempty directories. No recursive path traversal.
    delete_handle(&file)
}
fn delete_handle(file: &File) -> Result<()> {
    let deletion = FILE_DISPOSITION_INFO { DeleteFile: true };
    if unsafe {
        SetFileInformationByHandle(
            handle(file),
            FileDispositionInfo,
            (&deletion as *const FILE_DISPOSITION_INFO).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    } == 0
    {
        return Err(last_error());
    }
    Ok(())
}
fn info<T: Default>(file: &impl AsRawHandle, class: FILE_INFO_BY_HANDLE_CLASS) -> Result<T> {
    let mut value = T::default();
    // SAFETY: caller pairs the information class with its exact SDK struct.
    if unsafe {
        GetFileInformationByHandleEx(
            handle(file),
            class,
            (&mut value as *mut T).cast(),
            size_of::<T>() as u32,
        )
    } == 0
    {
        return Err(last_error());
    }
    Ok(value)
}
pub fn identity(file: &impl AsRawHandle) -> Result<Identity> {
    let value: FILE_ID_INFO = info(file, FileIdInfo)?;
    Ok(Identity {
        volume: value.VolumeSerialNumber,
        id: value.FileId.Identifier,
    })
}
fn raw_control(
    file: &File,
    code: u32,
    input: *const std::ffi::c_void,
    input_len: u32,
    output: &mut [u8],
) -> std::io::Result<usize> {
    let mut count = 0;
    // SAFETY: synchronous file handle and live input/output buffers of the
    // declared sizes; no OVERLAPPED object outlives this invocation.
    if unsafe {
        DeviceIoControl(
            handle(file),
            code,
            input,
            input_len,
            output.as_mut_ptr().cast(),
            output.len() as u32,
            &mut count,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(count as usize)
}
fn control(
    file: &File,
    code: u32,
    input: *const std::ffi::c_void,
    input_len: u32,
    output: &mut [u8],
) -> Result<usize> {
    raw_control(file, code, input, input_len, output).map_err(Into::into)
}
fn security_id(file: &File) -> Result<u32> {
    let input = READ_FILE_USN_DATA {
        MinMajorVersion: 2,
        MaxMajorVersion: 2,
    };
    let mut output = [0u8; 4096];
    let count = control(
        file,
        FSCTL_READ_FILE_USN_DATA,
        (&input as *const READ_FILE_USN_DATA).cast(),
        size_of::<READ_FILE_USN_DATA>() as u32,
        &mut output,
    )?;
    let offset = offset_of!(USN_RECORD_V2, SecurityId);
    if count < offset + 4
        || u16::from_le_bytes([output[4], output[5]]) != 2
        || u32::from_le_bytes(output[..4].try_into().expect("record length")) as usize > count
    {
        return Err(unsupported(
            "NTFS security identity is unavailable; metadata-safe replacement was refused",
        ));
    }
    let id = u32::from_le_bytes(
        output[offset..offset + 4]
            .try_into()
            .expect("bounded field"),
    );
    if id == 0 {
        return Err(unsupported(
            "The filesystem did not supply a security descriptor identity",
        ));
    }
    Ok(id)
}
fn only_default_stream(file: &File) -> Result<bool> {
    // Aligned bounded storage for FILE_STREAM_INFO's variable records.
    let mut buffer = vec![0u64; 8192];
    if unsafe {
        GetFileInformationByHandleEx(
            handle(file),
            FileStreamInfo,
            buffer.as_mut_ptr().cast(),
            (buffer.len() * 8) as u32,
        )
    } == 0
    {
        return if std::io::Error::last_os_error().raw_os_error() == Some(ERROR_HANDLE_EOF as i32) {
            Ok(true)
        } else {
            Err(last_error())
        };
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), buffer.len() * 8) };
    let mut offset = 0;
    loop {
        if offset + 24 > bytes.len() {
            return Err(unsupported("Malformed Windows stream metadata"));
        }
        let next =
            u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("bounded")) as usize;
        let length =
            u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().expect("bounded")) as usize;
        if length % 2 != 0 || length > bytes.len() - offset - 24 {
            return Err(unsupported("Malformed Windows stream name"));
        }
        let name: Vec<u16> = bytes[offset + 24..offset + 24 + length]
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        if String::from_utf16(&name).ok().as_deref() != Some("::$DATA") {
            return Ok(false);
        }
        if next == 0 {
            break;
        }
        if next < 24 + length || next > bytes.len() - offset {
            return Err(unsupported("Malformed Windows stream chain"));
        }
        offset += next;
    }
    Ok(true)
}
fn ntfs(file: &File) -> Result<bool> {
    let mut name = [0u16; 32];
    if unsafe {
        GetVolumeInformationByHandleW(
            handle(file),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            name.as_mut_ptr(),
            name.len() as u32,
        )
    } == 0
    {
        return Err(last_error());
    }
    Ok(
        String::from_utf16(&name[..name.iter().position(|&c| c == 0).unwrap_or(name.len())])
            .ok()
            .as_deref()
            == Some("NTFS"),
    )
}
pub fn supported_metadata(file: &File) -> Result<bool> {
    let basic: FILE_BASIC_INFO = info(file, FileBasicInfo)?;
    let standard: FILE_STANDARD_INFO = info(file, FileStandardInfo)?;
    let allowed = FILE_ATTRIBUTE_NORMAL
        | FILE_ATTRIBUTE_ARCHIVE
        | FILE_ATTRIBUTE_HIDDEN
        | FILE_ATTRIBUTE_SYSTEM
        | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED;
    if basic.FileAttributes & !allowed != 0
        || standard.NumberOfLinks != 1
        || standard.Directory
        || !ntfs(file)?
    {
        return Ok(false);
    }
    if !only_default_stream(file)? {
        return Ok(false);
    }
    let mut ea = FILE_EA_INFORMATION::default();
    let mut io = IO_STATUS_BLOCK::default();
    nt_result(unsafe {
        NtQueryInformationFile(
            handle(file),
            &mut io,
            (&mut ea as *mut FILE_EA_INFORMATION).cast(),
            size_of::<FILE_EA_INFORMATION>() as u32,
            FileEaInformation,
        )
    })?;
    if ea.EaSize != 0 {
        return Ok(false);
    }
    let mut object_id = [0u8; 64];
    match raw_control(file, FSCTL_GET_OBJECT_ID, ptr::null(), 0, &mut object_id) {
        Ok(_) => return Ok(false),
        Err(error) => {
            // Preserve unknown filesystem cases by refusing the save. The raw
            // Windows error is checked separately; AppError intentionally does
            // not leak paths or native arguments.
            let code = error.raw_os_error();
            if !matches!(code, Some(c) if c == ERROR_FILE_NOT_FOUND as i32 || c == ERROR_NOT_FOUND as i32 || c == windows_sys::Win32::Foundation::ERROR_OBJECT_NOT_FOUND as i32)
            {
                return Err(error.into());
            }
        }
    }
    security_id(file)?;
    Ok(true)
}
struct Security(PSECURITY_DESCRIPTOR);
impl Drop for Security {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
fn copy_security(source: &File, destination: &File) -> Result<()> {
    let expected = security_id(source)?;
    if security_id(destination)? == expected {
        return Ok(());
    }
    let mut owner: PSID = ptr::null_mut();
    let mut group: PSID = ptr::null_mut();
    let mut dacl: *mut ACL = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    let fields =
        OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
    let result = unsafe {
        GetSecurityInfo(
            handle(source),
            SE_FILE_OBJECT,
            fields,
            &mut owner,
            &mut group,
            &mut dacl,
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    if result != 0 {
        return Err(std::io::Error::from_raw_os_error(result as i32).into());
    }
    let descriptor = Security(descriptor);
    let mut flags = 0;
    let mut revision = 0;
    if unsafe { GetSecurityDescriptorControl(descriptor.0, &mut flags, &mut revision) } == 0 {
        return Err(last_error());
    }
    let protection = if flags & SE_DACL_PROTECTED != 0 {
        PROTECTED_DACL_SECURITY_INFORMATION
    } else {
        UNPROTECTED_DACL_SECURITY_INFORMATION
    };
    let result = unsafe {
        SetSecurityInfo(
            handle(destination),
            SE_FILE_OBJECT,
            fields | protection,
            owner,
            group,
            dacl,
            ptr::null(),
        )
    };
    if result != 0 {
        return Err(std::io::Error::from_raw_os_error(result as i32).into());
    }
    // Same-volume nonzero NTFS SecurityId identifies the complete shared
    // descriptor, including audit/label data we may lack privilege to read.
    // Refuse replacement unless exact identity survives; never discard a SACL
    // by assuming that copying the visible DACL was sufficient.
    if security_id(destination)? != expected {
        return Err(unsupported(
            "The complete Windows security descriptor could not be preserved",
        ));
    }
    Ok(())
}
fn rename_handle(file: &File, parent: &Dir, leaf: &Path, replace: bool) -> Result<()> {
    let name = leaf_name(leaf)?;
    let length = offset_of!(FILE_RENAME_INFO, FileName) + name.len() * 2;
    let mut buffer = vec![0usize; length.div_ceil(size_of::<usize>())];
    let rename = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // SAFETY: aligned storage covers the fixed SDK header plus every UTF-16
    // name unit; the directory capability and source handle remain owned.
    unsafe {
        (*rename).Anonymous.ReplaceIfExists = replace;
        (*rename).RootDirectory = handle(parent);
        (*rename).FileNameLength = (name.len() * 2) as u32;
        ptr::copy_nonoverlapping(
            name.as_ptr(),
            ptr::addr_of_mut!((*rename).FileName).cast::<u16>(),
            name.len(),
        );
        if SetFileInformationByHandle(handle(file), FileRenameInfo, rename.cast(), length as u32)
            == 0
        {
            return Err(last_error());
        }
    }
    Ok(())
}
pub fn rename_noreplace(from: &Dir, source: &Path, to: &Dir, target: &Path) -> Result<()> {
    let file = open_shared(
        from,
        source,
        DELETE_ACCESS | FILE_READ_ATTRIBUTES,
        false,
        false,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
    )
    .or_else(|error| {
        // Directories use their own handle and are never traversed through
        // a path-based rename fallback.
        open_shared(
            from,
            source,
            DELETE_ACCESS | FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
            false,
            true,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
        )
        .map_err(|_| error)
    })?;
    rename_handle(&file, to, target, false)
}
struct Temporary {
    file: File,
    committed: bool,
}
impl Drop for Temporary {
    fn drop(&mut self) {
        if !self.committed {
            // Delete our still-owned file object, never a name another writer
            // might have substituted at the temporary path.
            if delete_handle(&self.file).is_err() {
                // Never log a private name or file contents.
                tracing::warn!("An uncommitted Windows temporary file could not be removed");
            }
        }
    }
}

/// Pins the selected object against renames/deletion while its recovery record
/// is prepared. Other writers are still possible and must be revision checked.
pub fn open_for_delete(parent: &Dir, leaf: &Path) -> Result<File> {
    open_shared(
        parent,
        leaf,
        FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE_ACCESS,
        false,
        false,
        FILE_SHARE_READ,
    )
}
pub fn preserve_for_delete(file: &File, parent: &Dir, backup: &Dir) -> Result<Identity> {
    let id = identity(file)?;
    if id.volume != identity(backup)?.volume || !supported_metadata(file)? {
        return Err(unsupported(
            "Recoverable Windows deletion requires supported NTFS metadata and private recovery on the same volume",
        ));
    }
    // Prove a future copy can retain the entire descriptor before moving the
    // original into private recovery. A hidden SACL mismatch refuses deletion.
    let probe = Temporary {
        file: open(
            parent,
            Path::new(&format!(".agent-workspace-save-{}", uuid::Uuid::new_v4())),
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE_ACCESS | WRITE_DAC | WRITE_OWNER,
            true,
            false,
        )?,
        committed: false,
    };
    copy_security(file, &probe.file)?;
    Ok(id)
}
pub fn move_to_recovery(file: &File, backup: &Dir, leaf: &Path, expected: &[u8]) -> Result<()> {
    use std::io::{Seek, SeekFrom};
    let mut reader = file.try_clone()?;
    reader.seek(SeekFrom::Start(0))?;
    let mut current = Vec::new();
    reader.take(LIMIT + 1).read_to_end(&mut current)?;
    if current != expected {
        return Err(AppError::conflict(
            "File changed before deletion; original retained",
        ));
    }
    rename_handle(file, backup, leaf, false)?;
    file.sync_all().map_err(|_| {
        AppError::new(
            "unknownOutcome",
            "Deleted file moved into recovery but flush failed; recovery retained",
        )
    })
}
pub fn restore_copy(
    source: &File,
    parent: &Dir,
    leaf: &Path,
    expected: &Identity,
    bytes: &[u8],
) -> Result<()> {
    use std::io::{Seek, SeekFrom};
    let mut reader = source.try_clone()?;
    reader.seek(SeekFrom::Start(0))?;
    let mut current = Vec::new();
    reader.take(LIMIT + 1).read_to_end(&mut current)?;
    if identity(source)? != *expected
        || identity(parent)?.volume != expected.volume
        || !supported_metadata(source)?
        || current != bytes
    {
        return Err(unsupported(
            "Windows recovery identity or metadata cannot be preserved at this destination",
        ));
    }
    let basic: FILE_BASIC_INFO = info(source, FileBasicInfo)?;
    let mut output = Temporary {
        file: open_shared(
            parent,
            leaf,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE_ACCESS | WRITE_DAC | WRITE_OWNER,
            true,
            false,
            FILE_SHARE_READ,
        )?,
        committed: false,
    };
    output.file.write_all(bytes)?;
    copy_security(source, &output.file)?;
    let copied = FILE_BASIC_INFO {
        CreationTime: basic.CreationTime,
        LastAccessTime: basic.LastAccessTime,
        FileAttributes: basic.FileAttributes,
        ..Default::default()
    };
    if unsafe {
        SetFileInformationByHandle(
            handle(&output.file),
            FileBasicInfo,
            (&copied as *const FILE_BASIC_INFO).cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        )
    } == 0
    {
        return Err(last_error());
    }
    output.file.sync_all()?;
    output.committed = true;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Dir) {
        let temp = tempfile::tempdir().unwrap();
        let dir = Dir::open_ambient_dir(temp.path(), cap_std::ambient_authority()).unwrap();
        (temp, dir)
    }
    fn content(parent: &Dir, leaf: &str) -> Vec<u8> {
        let mut bytes = Vec::new();
        open_read(parent, Path::new(leaf))
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        bytes
    }
    #[test]
    fn exclusive_create_rename_and_case_only_move() {
        let (_temp, dir) = fixture();
        create(&dir, Path::new("hello.txt"), false).unwrap();
        create(&dir, Path::new("other.txt"), false).unwrap();
        let id = identity(&open_read(&dir, Path::new("hello.txt")).unwrap()).unwrap();
        assert!(create(&dir, Path::new("hello.txt"), false).is_err());
        assert!(
            rename_noreplace(&dir, Path::new("hello.txt"), &dir, Path::new("other.txt")).is_err()
        );
        rename_noreplace(&dir, Path::new("hello.txt"), &dir, Path::new("HELLO.txt")).unwrap();
        assert_eq!(
            identity(&open_read(&dir, Path::new("HELLO.txt")).unwrap()).unwrap(),
            id
        );
        let names = entries(&dir, 10).unwrap().0;
        assert!(names.iter().any(|(name, _)| name == "HELLO.txt"));
    }
    #[test]
    fn enumeration_and_reads_follow_owned_directory_after_path_replacement() {
        let (temp, dir) = fixture();
        create(&dir, Path::new("selected"), true).unwrap();
        let selected = open_directory(&dir, Path::new("selected")).unwrap();
        create(&selected, Path::new("owned.txt"), false).unwrap();
        std::fs::rename(temp.path().join("selected"), temp.path().join("moved")).unwrap();
        std::fs::create_dir(temp.path().join("selected")).unwrap();
        std::fs::write(temp.path().join("selected/outside.txt"), b"outside").unwrap();
        let (names, more) = entries(&selected, 10).unwrap();
        assert!(!more);
        assert_eq!(names.len(), 1);
        assert_eq!(names[0].0, "owned.txt");
        assert!(open_read(&selected, Path::new("outside.txt")).is_err());
        assert!(open_read(&dir, Path::new("selected/outside.txt")).is_err());
    }
    #[test]
    fn junction_is_visible_but_never_traversed() {
        let (temp, dir) = fixture();
        let outside = tempfile::tempdir().unwrap();
        let junction = temp.path().join("junction");
        let status = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&junction)
            .arg(outside.path())
            .status()
            .unwrap();
        assert!(
            status.success(),
            "Native junction fixture must be available"
        );
        assert!(open_directory(&dir, Path::new("junction")).is_err());
        assert_eq!(entries(&dir, 10).unwrap().0[0].1, "link");
        // Removing a junction is explicit fixture cleanup, never recursive.
        std::fs::remove_dir(junction).unwrap();
    }
    #[test]
    fn alternate_streams_hardlinks_and_readonly_metadata_refuse_replacement() {
        let (temp, dir) = fixture();
        std::fs::write(temp.path().join("file"), b"old").unwrap();
        std::fs::write(temp.path().join("file:secret"), b"keep").unwrap();
        assert!(!supported_metadata(&open_read(&dir, Path::new("file")).unwrap()).unwrap());
        std::fs::remove_file(temp.path().join("file:secret")).unwrap();
        std::fs::hard_link(temp.path().join("file"), temp.path().join("linked")).unwrap();
        assert!(!supported_metadata(&open_read(&dir, Path::new("file")).unwrap()).unwrap());
        std::fs::remove_file(temp.path().join("linked")).unwrap();
        let mut permissions = std::fs::metadata(temp.path().join("file"))
            .unwrap()
            .permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(temp.path().join("file"), permissions).unwrap();
        assert!(!supported_metadata(&open_read(&dir, Path::new("file")).unwrap()).unwrap());
        let mut permissions = std::fs::metadata(temp.path().join("file"))
            .unwrap()
            .permissions();
        permissions.set_readonly(false);
        std::fs::set_permissions(temp.path().join("file"), permissions).unwrap();
    }
    #[test]
    fn replacement_faults_preserve_original_or_complete_replacement() {
        for phase in 1..=4 {
            let (temp, dir) = fixture();
            std::fs::write(temp.path().join("file"), b"old").unwrap();
            let original = open_read(&dir, Path::new("file")).unwrap();
            assert!(
                supported_metadata(&original).unwrap(),
                "Native NTFS fixture must support safe replacement"
            );
            let id = identity(&original).unwrap();
            let security = security_id(&original).unwrap();
            let result = atomic_replace(&dir, Path::new("file"), b"old", b"new", &id, |point| {
                if point == phase {
                    Err(AppError::new("injected", "fault"))
                } else {
                    Ok(())
                }
            });
            assert!(result.is_err());
            assert_eq!(
                content(&dir, "file"),
                if phase < 4 { b"old" } else { b"new" }
            );
            assert_eq!(
                security_id(&open_read(&dir, Path::new("file")).unwrap()).unwrap(),
                security
            );
            assert!(
                !entries(&dir, 100)
                    .unwrap()
                    .0
                    .iter()
                    .any(|(name, _)| name.to_string_lossy().starts_with(".agent-workspace-save-"))
            );
        }
    }
    #[test]
    fn recoverable_delete_and_restore_retain_original_metadata_and_backup() {
        let (temp, dir) = fixture();
        create(&dir, Path::new("backup"), true).unwrap();
        let backup = open_directory(&dir, Path::new("backup")).unwrap();
        std::fs::write(temp.path().join("file"), b"keep").unwrap();
        let file = open_for_delete(&dir, Path::new("file")).unwrap();
        let id = preserve_for_delete(&file, &dir, &backup).unwrap();
        let security = security_id(&file).unwrap();
        move_to_recovery(&file, &backup, Path::new("recovery.bin"), b"keep").unwrap();
        drop(file);
        assert!(open_read(&dir, Path::new("file")).is_err());
        let source = open_read(&backup, Path::new("recovery.bin")).unwrap();
        assert_eq!(identity(&source).unwrap(), id);
        restore_copy(&source, &dir, Path::new("file"), &id, b"keep").unwrap();
        assert_eq!(content(&dir, "file"), b"keep");
        assert_eq!(content(&backup, "recovery.bin"), b"keep");
        assert_eq!(
            security_id(&open_read(&dir, Path::new("file")).unwrap()).unwrap(),
            security
        );
        assert!(restore_copy(&source, &dir, Path::new("file"), &id, b"keep").is_err());
        assert!(restore_copy(&source, &dir, Path::new("different"), &id, b"tampered").is_err());
    }
    #[test]
    fn directory_delete_is_empty_only() {
        let (_temp, dir) = fixture();
        create(&dir, Path::new("folder"), true).unwrap();
        let folder = open_directory(&dir, Path::new("folder")).unwrap();
        create(&folder, Path::new("child"), false).unwrap();
        assert!(remove_empty_directory(&dir, Path::new("folder")).is_err());
        drop(folder);
        create(&dir, Path::new("empty"), true).unwrap();
        remove_empty_directory(&dir, Path::new("empty")).unwrap();
        assert!(open_directory(&dir, Path::new("empty")).is_err());
    }
}
pub fn atomic_replace(
    parent: &Dir,
    leaf: &Path,
    expected: &[u8],
    bytes: &[u8],
    expected_id: &Identity,
    fault: impl Fn(u8) -> Result<()>,
) -> Result<()> {
    let mut original = open_read(parent, leaf)?;
    if identity(&original)? != *expected_id || !supported_metadata(&original)? {
        return Err(AppError::conflict(
            "Destination identity or metadata changed before saving",
        ));
    }
    let source_security = security_id(&original)?;
    let basic: FILE_BASIC_INFO = info(&original, FileBasicInfo)?;
    let temporary = format!(".agent-workspace-save-{}", uuid::Uuid::new_v4());
    let mut output = Temporary {
        file: open(
            parent,
            Path::new(&temporary),
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE_ACCESS | WRITE_DAC | WRITE_OWNER,
            true,
            false,
        )?,
        committed: false,
    };
    fault(1)?;
    output.file.write_all(bytes)?;
    copy_security(&original, &output.file)?;
    let copied = FILE_BASIC_INFO {
        CreationTime: basic.CreationTime,
        LastAccessTime: basic.LastAccessTime,
        FileAttributes: basic.FileAttributes | FILE_ATTRIBUTE_ARCHIVE,
        ..Default::default()
    };
    if unsafe {
        SetFileInformationByHandle(
            handle(&output.file),
            FileBasicInfo,
            (&copied as *const FILE_BASIC_INFO).cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        )
    } == 0
    {
        return Err(last_error());
    }
    output.file.sync_all()?;
    fault(2)?;
    let mut current = open_read(parent, leaf)?;
    let now: FILE_BASIC_INFO = info(&current, FileBasicInfo)?;
    let mut old = Vec::new();
    (&mut current).take(LIMIT + 1).read_to_end(&mut old)?;
    if old != expected
        || identity(&current)? != *expected_id
        || security_id(&current)? != source_security
        || !supported_metadata(&current)?
        || now.CreationTime != basic.CreationTime
        || now.LastWriteTime != basic.LastWriteTime
        || now.ChangeTime != basic.ChangeTime
        || now.FileAttributes != basic.FileAttributes
    {
        return Err(AppError::conflict(
            "Destination changed while saving; original retained",
        ));
    }
    // Original data is checked through its owned handle as well as the name.
    let mut original_bytes = Vec::new();
    (&mut original)
        .take(LIMIT + 1)
        .read_to_end(&mut original_bytes)?;
    if original_bytes != expected {
        return Err(AppError::conflict("Original file changed while saving"));
    }
    fault(3)?;
    let output_id = identity(&output.file)?;
    rename_handle(&output.file, parent, leaf, true)?;
    output.committed = true;
    fault(4)?;
    // Windows has no generally usable directory-fsync equivalent for ordinary
    // directory capabilities. Flush the renamed file, read back the namespace,
    // and retain recovery on uncertain acknowledgement. Power-loss behaviour
    // still requires the native NTFS crash matrix; no stronger claim is made.
    output.file.sync_all().map_err(|_| {
        AppError::new(
            "unknownOutcome",
            "Replacement completed but flush failed; recovery retained",
        )
    })?;
    let mut saved = open_read(parent, leaf).map_err(|_| {
        AppError::new(
            "unknownOutcome",
            "Saved destination unavailable; recovery retained",
        )
    })?;
    let mut result = Vec::new();
    (&mut saved).take(LIMIT + 1).read_to_end(&mut result)?;
    if result != bytes || identity(&saved)? != output_id || security_id(&saved)? != source_security
    {
        return Err(AppError::new(
            "unknownOutcome",
            "Saved file changed before acknowledgement; recovery retained",
        ));
    }
    Ok(())
}

/// A new staged ordinary file. Existing reparse/stream/metadata guards remain;
/// byte copying is streamed and never bounded by the editor preview limit.
pub fn copy_file(source: &File, parent: &Dir, leaf: &Path) -> Result<()> {
    if !supported_metadata(source)? {
        return Err(unsupported(
            "This file's Windows metadata cannot be preserved by Explorer copy; the original was kept",
        ));
    }
    let mut output = Temporary {
        file: open(
            parent,
            leaf,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE_ACCESS | WRITE_DAC | WRITE_OWNER,
            true,
            false,
        )?,
        committed: false,
    };
    std::io::copy(&mut source.try_clone()?, &mut output.file)?;
    copy_security(source, &output.file)?;
    copy_basic(source, &output.file)?;
    output.file.sync_all()?;
    output.committed = true;
    Ok(())
}
fn copy_basic(source: &File, destination: &File) -> Result<()> {
    let basic: FILE_BASIC_INFO = info(source, FileBasicInfo)?;
    // SAFETY: live owned handles and an exactly sized FILE_BASIC_INFO buffer.
    if unsafe {
        SetFileInformationByHandle(
            handle(destination),
            FileBasicInfo,
            (&basic as *const FILE_BASIC_INFO).cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        )
    } == 0
    {
        return Err(last_error());
    }
    Ok(())
}
pub fn copy_directory_metadata(from: &Dir, source: &Path, to: &Dir, target: &Path) -> Result<()> {
    let original = open(from, source, FILE_GENERIC_READ, false, true)?;
    let copied = open(
        to,
        target,
        FILE_GENERIC_READ | FILE_GENERIC_WRITE | WRITE_DAC | WRITE_OWNER,
        false,
        true,
    )?;
    copy_security(&original, &copied)?;
    copy_basic(&original, &copied)
}
