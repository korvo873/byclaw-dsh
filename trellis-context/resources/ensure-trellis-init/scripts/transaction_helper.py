#!/usr/bin/env python3

"""Descriptor-relative pending-bootstrap transaction operations for POSIX hosts."""

from __future__ import annotations

import hashlib
import fcntl
import json
import os
import stat
import subprocess
import sys
import uuid
from dataclasses import dataclass
from typing import Any


RECORD_VERSION = 1
MAX_RECORD_BYTES = 64 * 1024
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
READ_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
TEST_HOOK: str | None = None
TEST_FAULT: str | None = None


class IncompleteRecordError(RuntimeError):
    """A helper-owned final record does not contain one complete supported value."""


def identity(info: os.stat_result) -> tuple[int, int]:
    return info.st_dev, info.st_ino


def transaction_name(project_root: str) -> str:
    return f"{hashlib.sha256(project_root.encode('utf-8')).hexdigest()}.pending"


def lock_name(project_root: str) -> str:
    return f"{hashlib.sha256(project_root.encode('utf-8')).hexdigest()}.lock"


def validate_absolute(path: str, label: str) -> str:
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        raise RuntimeError(f"{label} must be a normalized absolute POSIX path: {path}")
    return path


def race_hook(stage: str, subject: str) -> None:
    if TEST_HOOK is not None:
        subprocess.run([TEST_HOOK, stage, subject], check=True)


def fault(stage: str) -> None:
    if TEST_FAULT == stage:
        os._exit(97)


def validate_parent(info: os.stat_result, path: str) -> None:
    if not stat.S_ISDIR(info.st_mode):
        raise RuntimeError(f"transaction parent is not a directory: {path}")
    if info.st_uid not in (0, os.geteuid()):
        raise RuntimeError(f"transaction parent has an unsafe owner: {path}")
    if stat.S_IMODE(info.st_mode) & 0o022:
        raise RuntimeError(f"transaction parent is group/world-writable: {path}")


@dataclass
class DirectoryChain:
    path: str
    descriptors: list[int]

    @property
    def final(self) -> int:
        return self.descriptors[-1]

    @property
    def final_identity(self) -> tuple[int, int]:
        return identity(os.fstat(self.final))

    def close(self) -> None:
        for descriptor in reversed(self.descriptors):
            os.close(descriptor)

    def __enter__(self) -> DirectoryChain:
        return self

    def __exit__(self, _kind: object, _error: object, _traceback: object) -> None:
        self.close()


def open_directory_chain(path: str, *, create: bool, hooks: bool = True) -> DirectoryChain:
    absolute = validate_absolute(path, "stateDir")
    descriptors = [os.open("/", DIRECTORY_FLAGS)]
    try:
        validate_parent(os.fstat(descriptors[0]), "/")
        current = ""
        components = [component for component in absolute.split("/") if component]
        for component in components:
            parent_fd = descriptors[-1]
            current = f"{current}/{component}"
            try:
                child_fd = os.open(component, DIRECTORY_FLAGS, dir_fd=parent_fd)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(component, 0o700, dir_fd=parent_fd)
                    os.fsync(parent_fd)
                except FileExistsError:
                    pass
                child_fd = os.open(component, DIRECTORY_FLAGS, dir_fd=parent_fd)
            descriptors.append(child_fd)
            if hooks:
                race_hook("after-component-open", current)
            descriptor_info = os.fstat(child_fd)
            validate_parent(descriptor_info, current)
            pathname_info = os.stat(component, dir_fd=parent_fd, follow_symlinks=False)
            if identity(descriptor_info) != identity(pathname_info):
                raise RuntimeError(f"transaction parent changed while opening: {current}")
            if hooks:
                race_hook("after-component-check", current)
        final_info = os.fstat(descriptors[-1])
        if final_info.st_uid != os.geteuid() or stat.S_IMODE(final_info.st_mode) != 0o700:
            raise RuntimeError(f"stateDir is not an owner-only directory: {absolute}")
        return DirectoryChain(absolute, descriptors)
    except BaseException:
        for descriptor in reversed(descriptors):
            os.close(descriptor)
        raise


def revalidate_state_directory(chain: DirectoryChain) -> None:
    with open_directory_chain(chain.path, create=False, hooks=False) as current:
        if current.final_identity != chain.final_identity:
            raise RuntimeError(f"stateDir was replaced: {chain.path}")


def project_record_from_fd(root_fd: int, canonical_root: str) -> dict[str, Any]:
    root_info = os.fstat(root_fd)
    if not stat.S_ISDIR(root_info.st_mode):
        raise RuntimeError(f"project root is not a directory: {canonical_root}")
    root_path_info = os.stat(canonical_root, follow_symlinks=False)
    if identity(root_info) != identity(root_path_info):
        raise RuntimeError(f"project root was replaced: {canonical_root}")
    modules_fd = os.open(".gitmodules", READ_FLAGS, dir_fd=root_fd)
    try:
        before = os.fstat(modules_fd)
        if not stat.S_ISREG(before.st_mode):
            raise RuntimeError(f".gitmodules is not a regular file: {canonical_root}/.gitmodules")
        modules_path_info = os.stat(".gitmodules", dir_fd=root_fd, follow_symlinks=False)
        if identity(before) != identity(modules_path_info):
            raise RuntimeError(f".gitmodules changed while opening: {canonical_root}/.gitmodules")
        digest = hashlib.sha256()
        while True:
            chunk = os.read(modules_fd, 64 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(modules_fd)
        stable_fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
        if any(getattr(before, field) != getattr(after, field) for field in stable_fields):
            raise RuntimeError(f".gitmodules changed while reading: {canonical_root}/.gitmodules")
        modules_path_after = os.stat(".gitmodules", dir_fd=root_fd, follow_symlinks=False)
        if any(getattr(after, field) != getattr(modules_path_after, field) for field in stable_fields):
            raise RuntimeError(f".gitmodules was replaced while reading: {canonical_root}/.gitmodules")
        root_path_after = os.stat(canonical_root, follow_symlinks=False)
        if identity(root_info) != identity(root_path_after):
            raise RuntimeError(f"project root was replaced while reading: {canonical_root}")
        return {
            "version": RECORD_VERSION,
            "project": {
                "canonicalRoot": canonical_root,
                "device": str(root_info.st_dev),
                "inode": str(root_info.st_ino),
            },
            "gitmodules": {
                "device": str(before.st_dev),
                "inode": str(before.st_ino),
                "size": str(before.st_size),
                "mtimeNs": str(before.st_mtime_ns),
                "ctimeNs": str(before.st_ctime_ns),
                "sha256": digest.hexdigest(),
            },
        }
    finally:
        os.close(modules_fd)


def open_project_root(project_root: str) -> int:
    canonical_root = validate_absolute(project_root, "project root")
    if os.path.realpath(canonical_root) != canonical_root:
        raise RuntimeError(f"project root is not canonical: {canonical_root}")
    root_fd = os.open(canonical_root, DIRECTORY_FLAGS)
    try:
        project_record_from_fd(root_fd, canonical_root)
        return root_fd
    except BaseException:
        os.close(root_fd)
        raise


def project_record(project_root: str) -> dict[str, Any]:
    root_fd = open_project_root(project_root)
    try:
        return project_record_from_fd(root_fd, project_root)
    finally:
        os.close(root_fd)


def record_bytes(record: dict[str, Any]) -> bytes:
    return (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def validate_record(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"version", "project", "gitmodules"}:
        raise RuntimeError("pending bootstrap record has invalid fields")
    project = value.get("project")
    gitmodules = value.get("gitmodules")
    if value.get("version") != RECORD_VERSION or not isinstance(project, dict) or not isinstance(gitmodules, dict):
        raise RuntimeError("pending bootstrap record has an unsupported version")
    if set(project) != {"canonicalRoot", "device", "inode"}:
        raise RuntimeError("pending bootstrap record has invalid project identity")
    if set(gitmodules) != {"device", "inode", "size", "mtimeNs", "ctimeNs", "sha256"}:
        raise RuntimeError("pending bootstrap record has invalid .gitmodules identity")
    if not all(isinstance(project.get(key), str) and project[key] for key in project):
        raise RuntimeError("pending bootstrap record has malformed project identity")
    if not all(isinstance(gitmodules.get(key), str) and gitmodules[key] for key in gitmodules):
        raise RuntimeError("pending bootstrap record has malformed .gitmodules identity")
    digest = gitmodules["sha256"]
    if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
        raise RuntimeError("pending bootstrap record has malformed .gitmodules digest")
    return value


def read_marker(state_fd: int, state_dir: str, name: str) -> tuple[int, os.stat_result, bytes, dict[str, Any]]:
    marker_fd = os.open(name, READ_FLAGS, dir_fd=state_fd)
    try:
        race_hook("after-marker-open", os.path.join(state_dir, name))
        marker_info = os.fstat(marker_fd)
        if not stat.S_ISREG(marker_info.st_mode):
            raise RuntimeError("pending bootstrap record is not a regular file")
        if marker_info.st_uid != os.geteuid() or stat.S_IMODE(marker_info.st_mode) != 0o600:
            raise RuntimeError("pending bootstrap record is not owner-only")
        pathname_info = os.stat(name, dir_fd=state_fd, follow_symlinks=False)
        if identity(marker_info) != identity(pathname_info):
            raise RuntimeError("pending bootstrap record changed while opening")
        chunks: list[bytes] = []
        remaining = MAX_RECORD_BYTES + 1
        while remaining > 0:
            chunk = os.read(marker_fd, min(remaining, 8192))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        content = b"".join(chunks)
        if len(content) > MAX_RECORD_BYTES:
            raise RuntimeError("pending bootstrap record exceeds the byte limit")
        try:
            decoded = json.loads(content.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise IncompleteRecordError("pending bootstrap record is incomplete") from error
        value = validate_record(decoded)
        return marker_fd, marker_info, content, value
    except BaseException:
        os.close(marker_fd)
        raise


def base_result(chain: DirectoryChain, project_root: str) -> dict[str, str]:
    name = transaction_name(project_root)
    state_dev, state_ino = chain.final_identity
    return {
        "stateDir": chain.path,
        "transactionPath": os.path.join(chain.path, name),
        "stateDev": str(state_dev),
        "stateIno": str(state_ino),
    }


def present_result(
    status: str,
    chain: DirectoryChain,
    project_root: str,
    marker_info: os.stat_result,
    content: bytes,
) -> dict[str, str]:
    return {
        "status": status,
        **base_result(chain, project_root),
        "markerDev": str(marker_info.st_dev),
        "markerIno": str(marker_info.st_ino),
        "recordDigest": hashlib.sha256(content).hexdigest(),
    }


def quarantine(chain: DirectoryChain, name: str, marker_info: os.stat_result, prefix: str) -> str:
    quarantine_name = f".{prefix}-{uuid.uuid4().hex}.json"
    os.rename(name, quarantine_name, src_dir_fd=chain.final, dst_dir_fd=chain.final)
    race_hook("after-quarantine", chain.path)
    moved = os.stat(quarantine_name, dir_fd=chain.final, follow_symlinks=False)
    if identity(moved) != identity(marker_info):
        raise RuntimeError("pending bootstrap record changed during quarantine")
    revalidate_state_directory(chain)
    race_hook("after-final-revalidation", chain.path)
    os.fsync(chain.final)
    return quarantine_name


def remove_inspected_marker(chain: DirectoryChain, name: str, marker_info: os.stat_result) -> None:
    quarantine_name = f".cleanup-{uuid.uuid4().hex}.json"
    os.rename(name, quarantine_name, src_dir_fd=chain.final, dst_dir_fd=chain.final)
    race_hook("after-quarantine", chain.path)
    moved = os.stat(quarantine_name, dir_fd=chain.final, follow_symlinks=False)
    if identity(moved) != identity(marker_info):
        raise RuntimeError("pending bootstrap record changed during cleanup quarantine")
    try:
        revalidate_state_directory(chain)
    except BaseException:
        os.rename(quarantine_name, name, src_dir_fd=chain.final, dst_dir_fd=chain.final)
        os.fsync(chain.final)
        raise
    race_hook("after-final-revalidation", chain.path)
    os.unlink(quarantine_name, dir_fd=chain.final)
    os.fsync(chain.final)


def prepare(state_dir: str, project_root: str) -> dict[str, str]:
    validate_absolute(project_root, "project root")
    with open_directory_chain(state_dir, create=True) as chain:
        revalidate_state_directory(chain)
        return {"status": "prepared", **base_result(chain, project_root)}


def publication_prefix(project_root: str) -> str:
    return f".publish-{hashlib.sha256(project_root.encode('utf-8')).hexdigest()}-"


def cleanup_publication_residue(chain: DirectoryChain, project_root: str) -> None:
    prefix = publication_prefix(project_root)
    changed = False
    for entry in os.listdir(chain.final):
        if not entry.startswith(prefix) or not entry.endswith(".tmp"):
            continue
        info = os.stat(entry, dir_fd=chain.final, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise RuntimeError("pending bootstrap publication residue is not owner-only")
        os.unlink(entry, dir_fd=chain.final)
        changed = True
    if changed:
        os.fsync(chain.final)


def write_all(descriptor: int, content: bytes) -> None:
    offset = 0
    while offset < len(content):
        offset += os.write(descriptor, content[offset:])


def publish_record(chain: DirectoryChain, name: str, project_root: str, content: bytes) -> os.stat_result:
    temporary_name = f"{publication_prefix(project_root)}{uuid.uuid4().hex}.tmp"
    temporary_fd = os.open(
        temporary_name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
        dir_fd=chain.final,
    )
    temporary_exists = True
    try:
        split = max(1, len(content) // 2)
        write_all(temporary_fd, content[:split])
        fault("after-partial-write")
        write_all(temporary_fd, content[split:])
        os.fsync(temporary_fd)
        fault("after-file-fsync")
        temporary_info = os.fstat(temporary_fd)
        os.link(
            temporary_name,
            name,
            src_dir_fd=chain.final,
            dst_dir_fd=chain.final,
            follow_symlinks=False,
        )
        fault("after-install")
        marker_info = os.stat(name, dir_fd=chain.final, follow_symlinks=False)
        if identity(marker_info) != identity(temporary_info):
            raise RuntimeError("pending bootstrap record changed while publishing")
        os.unlink(temporary_name, dir_fd=chain.final)
        temporary_exists = False
        fault("before-directory-fsync")
        revalidate_state_directory(chain)
        os.fsync(chain.final)
        return marker_info
    finally:
        os.close(temporary_fd)
        if temporary_exists:
            try:
                os.unlink(temporary_name, dir_fd=chain.final)
            except FileNotFoundError:
                pass


def replace_record(
    chain: DirectoryChain,
    name: str,
    project_root: str,
    expected_marker: os.stat_result,
    content: bytes,
) -> os.stat_result:
    temporary_name = f"{publication_prefix(project_root)}{uuid.uuid4().hex}.tmp"
    temporary_fd = os.open(
        temporary_name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
        dir_fd=chain.final,
    )
    temporary_exists = True
    try:
        write_all(temporary_fd, content)
        os.fsync(temporary_fd)
        temporary_info = os.fstat(temporary_fd)
        current_marker = os.stat(name, dir_fd=chain.final, follow_symlinks=False)
        if identity(current_marker) != identity(expected_marker):
            raise RuntimeError("pending bootstrap record changed before identity advance")
        os.rename(temporary_name, name, src_dir_fd=chain.final, dst_dir_fd=chain.final)
        temporary_exists = False
        marker_info = os.stat(name, dir_fd=chain.final, follow_symlinks=False)
        if identity(marker_info) != identity(temporary_info):
            raise RuntimeError("pending bootstrap record changed during identity advance")
        revalidate_state_directory(chain)
        os.fsync(chain.final)
        return marker_info
    finally:
        os.close(temporary_fd)
        if temporary_exists:
            try:
                os.unlink(temporary_name, dir_fd=chain.final)
            except FileNotFoundError:
                pass


def open_project_lock(chain: DirectoryChain, project_root: str) -> int:
    name = lock_name(project_root)
    try:
        descriptor = os.open(
            name,
            os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
            dir_fd=chain.final,
        )
    except FileExistsError:
        descriptor = os.open(name, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=chain.final)
    try:
        descriptor_info = os.fstat(descriptor)
        pathname_info = os.stat(name, dir_fd=chain.final, follow_symlinks=False)
        if not stat.S_ISREG(descriptor_info.st_mode) or identity(descriptor_info) != identity(pathname_info):
            raise RuntimeError("project transaction lock changed while opening")
        if descriptor_info.st_uid != os.geteuid() or stat.S_IMODE(descriptor_info.st_mode) != 0o600:
            raise RuntimeError("project transaction lock is not owner-only")
        os.fsync(descriptor)
        os.fsync(chain.final)
        race_hook("before-project-lock", project_root)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        race_hook("after-project-lock", project_root)
        revalidate_state_directory(chain)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def assert_project_lock(state_fd: int, project_root: str, lock_fd: int) -> None:
    expected = os.fstat(lock_fd)
    pathname = os.stat(lock_name(project_root), dir_fd=state_fd, follow_symlinks=False)
    if identity(expected) != identity(pathname):
        raise RuntimeError("project transaction lock was replaced")
    probe = os.open(
        lock_name(project_root),
        os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC,
        dir_fd=state_fd,
    )
    try:
        try:
            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        fcntl.flock(probe, fcntl.LOCK_UN)
        raise RuntimeError("project transaction lock is not held")
    finally:
        os.close(probe)


def retained_chain(state_dir: str, state_fd: int) -> DirectoryChain:
    chain = DirectoryChain(validate_absolute(state_dir, "stateDir"), [os.dup(state_fd)])
    final_info = os.fstat(chain.final)
    if final_info.st_uid != os.geteuid() or stat.S_IMODE(final_info.st_mode) != 0o700:
        chain.close()
        raise RuntimeError(f"stateDir is not an owner-only directory: {state_dir}")
    revalidate_state_directory(chain)
    return chain


def ensure_in_chain(
    chain: DirectoryChain,
    project_root: str,
    current: dict[str, Any],
) -> dict[str, str]:
    content = record_bytes(current)
    name = transaction_name(project_root)
    cleanup_publication_residue(chain, project_root)
    try:
        marker_fd, marker_info, stored_content, stored = read_marker(chain.final, chain.path, name)
    except FileNotFoundError:
        marker_info = publish_record(chain, name, project_root, content)
        return present_result("created", chain, project_root, marker_info, content)
    except IncompleteRecordError:
        marker_info = os.stat(name, dir_fd=chain.final, follow_symlinks=False)
        quarantine(chain, name, marker_info, "incomplete")
        marker_info = publish_record(chain, name, project_root, content)
        return present_result("created", chain, project_root, marker_info, content)
    else:
        try:
            if stored != current:
                quarantine_name = quarantine(chain, name, marker_info, "stale")
                return {
                    "status": "mismatch",
                    **base_result(chain, project_root),
                    "quarantineName": quarantine_name,
                }
            revalidate_state_directory(chain)
            return present_result("present", chain, project_root, marker_info, stored_content)
        finally:
            os.close(marker_fd)


def inspect_in_chain(
    chain: DirectoryChain,
    project_root: str,
    current: dict[str, Any],
) -> dict[str, str]:
    name = transaction_name(project_root)
    try:
        marker_fd, marker_info, content, stored = read_marker(chain.final, chain.path, name)
    except FileNotFoundError:
        return {"status": "absent", **base_result(chain, project_root)}
    except IncompleteRecordError:
        marker_info = os.stat(name, dir_fd=chain.final, follow_symlinks=False)
        quarantine_name = quarantine(chain, name, marker_info, "incomplete")
        return {
            "status": "mismatch",
            **base_result(chain, project_root),
            "quarantineName": quarantine_name,
        }
    try:
        if stored != current:
            quarantine_name = quarantine(chain, name, marker_info, "stale")
            return {
                "status": "mismatch",
                **base_result(chain, project_root),
                "quarantineName": quarantine_name,
            }
        revalidate_state_directory(chain)
        return present_result("present", chain, project_root, marker_info, content)
    finally:
        os.close(marker_fd)


def inspect(state_dir: str, project_root: str) -> dict[str, str]:
    try:
        chain = open_directory_chain(state_dir, create=False)
    except FileNotFoundError:
        return {"status": "absent"}
    with chain:
        lock_fd = open_project_lock(chain, project_root)
        try:
            return inspect_in_chain(chain, project_root, project_record(project_root))
        finally:
            os.close(lock_fd)


def ensure(state_dir: str, project_root: str) -> dict[str, str]:
    with open_directory_chain(state_dir, create=True) as chain:
        lock_fd = open_project_lock(chain, project_root)
        try:
            return ensure_in_chain(chain, project_root, project_record(project_root))
        finally:
            os.close(lock_fd)


def clear(arguments: list[str]) -> dict[str, str]:
    if len(arguments) != 8:
        raise RuntimeError("clear requires stateDir, projectRoot, directory identity, marker identity, and record digest")
    _, state_dir, project_root, state_dev, state_ino, marker_dev, marker_ino, expected_digest = arguments
    if len(expected_digest) != 64:
        raise RuntimeError("invalid expected record digest")
    with open_directory_chain(state_dir, create=False) as chain:
        if chain.final_identity != (int(state_dev), int(state_ino)):
            raise RuntimeError(f"stateDir was replaced: {state_dir}")
        name = transaction_name(project_root)
        try:
            marker_fd, marker_info, content, stored = read_marker(chain.final, chain.path, name)
        except FileNotFoundError:
            return {"status": "absent", **base_result(chain, project_root)}
        try:
            if identity(marker_info) != (int(marker_dev), int(marker_ino)):
                raise RuntimeError("pending bootstrap record was replaced")
            if hashlib.sha256(content).hexdigest() != expected_digest:
                raise RuntimeError("pending bootstrap record content was replaced")
            if stored != project_record(project_root):
                quarantine_name = quarantine(chain, name, marker_info, "stale")
                return {
                    "status": "mismatch",
                    **base_result(chain, project_root),
                    "quarantineName": quarantine_name,
                }
            remove_inspected_marker(chain, name, marker_info)
            return {"status": "cleared", **base_result(chain, project_root)}
        finally:
            os.close(marker_fd)


def locked_context(arguments: list[str]) -> tuple[DirectoryChain, int, int, str]:
    if len(arguments) < 6:
        raise RuntimeError("locked operation requires stateDir, projectRoot, state descriptor, root descriptor, and lock descriptor")
    state_dir, project_root = arguments[1:3]
    state_fd, root_fd, lock_fd = (int(value) for value in arguments[3:6])
    chain = retained_chain(state_dir, state_fd)
    try:
        assert_project_lock(chain.final, project_root, lock_fd)
        root_info = os.fstat(root_fd)
        cwd_info = os.stat(".", follow_symlinks=False)
        if identity(root_info) != identity(cwd_info):
            raise RuntimeError("locked initializer cwd does not match the retained project root")
        return chain, root_fd, lock_fd, project_root
    except BaseException:
        chain.close()
        raise


def locked_dispatch(arguments: list[str]) -> dict[str, str]:
    operation = arguments[0]
    chain, root_fd, _lock_fd, project_root = locked_context(arguments)
    with chain:
        if operation == "locked-inspect":
            if len(arguments) != 6:
                raise RuntimeError("locked-inspect has unexpected arguments")
            current = project_record_from_fd(root_fd, project_root)
            return inspect_in_chain(chain, project_root, current)
        if operation == "locked-ensure":
            if len(arguments) != 6:
                raise RuntimeError("locked-ensure has unexpected arguments")
            current = project_record_from_fd(root_fd, project_root)
            result = ensure_in_chain(chain, project_root, current)
            if result["status"] in ("created", "present"):
                race_hook("after-record-validation", project_root)
            return result
        if operation == "locked-revalidate":
            if len(arguments) != 7:
                raise RuntimeError("locked-revalidate requires one phase")
            phase = arguments[6]
            current = project_record_from_fd(root_fd, project_root)
            result = inspect_in_chain(chain, project_root, current)
            if result["status"] != "present":
                raise RuntimeError(f"pending bootstrap record is not current before {phase}")
            race_hook(phase, project_root)
            return {**result, "status": "validated"}
        if operation == "locked-advance":
            if len(arguments) != 9:
                raise RuntimeError("locked-advance requires the validated marker identity and record digest")
            expected_marker = (int(arguments[6]), int(arguments[7]))
            expected_digest = arguments[8]
            if len(expected_digest) != 64 or any(character not in "0123456789abcdef" for character in expected_digest):
                raise RuntimeError("locked-advance has an invalid record digest")
            name = transaction_name(project_root)
            marker_fd, marker_info, stored_content, stored = read_marker(chain.final, chain.path, name)
            try:
                if identity(marker_info) != expected_marker:
                    raise RuntimeError("pending bootstrap record identity changed before identity advance")
                if hashlib.sha256(stored_content).hexdigest() != expected_digest:
                    raise RuntimeError("pending bootstrap record content changed before identity advance")
                current = project_record_from_fd(root_fd, project_root)
                if stored == current:
                    return present_result("present", chain, project_root, marker_info, stored_content)
                if stored["project"] != current["project"]:
                    raise RuntimeError("project root identity changed during bootstrap checkout")
                content = record_bytes(current)
                marker_info = replace_record(chain, name, project_root, marker_info, content)
                return present_result("advanced", chain, project_root, marker_info, content)
            finally:
                os.close(marker_fd)
        raise RuntimeError(f"unknown locked transaction operation: {operation}")


def validate_locked_script(path: str) -> str:
    absolute = validate_absolute(path, "locked script")
    info = os.lstat(absolute)
    if not stat.S_ISREG(info.st_mode):
        raise RuntimeError(f"locked script is not a regular file: {absolute}")
    return absolute


def lock_exec(arguments: list[str]) -> int:
    if len(arguments) != 5:
        raise RuntimeError("lock-exec requires stateDir, projectRoot, script, and Git-presence flag")
    _, state_dir, project_root, script, git_present = arguments
    if git_present not in ("0", "1"):
        raise RuntimeError("lock-exec Git-presence flag must be 0 or 1")
    script = validate_locked_script(script)
    with open_directory_chain(state_dir, create=True) as chain:
        lock_fd = open_project_lock(chain, project_root)
        try:
            root_fd = open_project_root(project_root)
            try:
                os.fchdir(root_fd)
                command = ["bash", script, "--locked-phase", project_root, git_present]
                if TEST_HOOK is not None:
                    command.extend(["--test-hook", TEST_HOOK])
                if TEST_FAULT is not None:
                    command.extend(["--test-fault", TEST_FAULT])
                completed = subprocess.run(
                    command,
                    check=False,
                    pass_fds=(chain.final, root_fd, lock_fd),
                    env={
                        **os.environ,
                        "TRELLIS_CONTEXT_LOCKED_STATE_FD": str(chain.final),
                        "TRELLIS_CONTEXT_LOCKED_ROOT_FD": str(root_fd),
                        "TRELLIS_CONTEXT_LOCKED_LOCK_FD": str(lock_fd),
                    },
                )
                return completed.returncode
            finally:
                os.close(root_fd)
        finally:
            os.close(lock_fd)


def dispatch(arguments: list[str]) -> dict[str, str]:
    if not arguments:
        raise RuntimeError("transaction operation is required")
    operation = arguments[0]
    if operation.startswith("locked-"):
        return locked_dispatch(arguments)
    if operation == "clear":
        return clear(arguments)
    if len(arguments) != 3:
        raise RuntimeError(f"{operation} requires stateDir and projectRoot")
    _, state_dir, project_root = arguments
    if operation == "prepare":
        return prepare(state_dir, project_root)
    if operation == "inspect":
        return inspect(state_dir, project_root)
    if operation == "ensure":
        return ensure(state_dir, project_root)
    raise RuntimeError(f"unknown transaction operation: {operation}")


def parse_test_options(arguments: list[str]) -> list[str]:
    global TEST_FAULT, TEST_HOOK
    remaining = list(arguments)
    while remaining and remaining[0] in ("--test-fault", "--test-hook"):
        option = remaining.pop(0)
        if not remaining:
            raise RuntimeError(f"{option} requires a value")
        value = remaining.pop(0)
        if option == "--test-fault":
            TEST_FAULT = value
        else:
            TEST_HOOK = value
    return remaining


def main() -> int:
    if os.name != "posix":
        print("transaction helper requires POSIX descriptor-relative filesystem operations", file=sys.stderr)
        return 1
    try:
        arguments = parse_test_options(sys.argv[1:])
        if arguments and arguments[0] == "lock-exec":
            return lock_exec(arguments)
        result = dispatch(arguments)
    except BaseException as error:
        print(f"trellis-context transaction helper: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
