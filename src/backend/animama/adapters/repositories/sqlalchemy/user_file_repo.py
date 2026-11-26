"""SQLAlchemy repository for account-owned user files."""

from __future__ import annotations

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from animama.app.ports.user_file_port import UserFileRepository
from animama.domain.user_file import STATUS_DELETED, UserFile
from animama.orm.user_file import ORMUserFile


class SQLAlchemyUserFileRepository(UserFileRepository):
    """Persist user file metadata using SQLAlchemy async sessions."""

    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    @staticmethod
    def _orm_to_domain(obj: ORMUserFile) -> UserFile:
        return UserFile(
            id=obj.id,
            user_id=obj.user_id,
            storage_locator=obj.storage_locator,
            original_filename=obj.original_filename,
            normalized_extension=obj.normalized_extension,
            declared_content_type=obj.declared_content_type,
            detected_content_type=obj.detected_content_type,
            declared_size_bytes=obj.declared_size_bytes,
            stored_size_bytes=obj.stored_size_bytes,
            sha256=obj.sha256,
            status=obj.status,
            upload_expires_at=obj.upload_expires_at,
            processed_at=obj.processed_at,
            last_error=obj.last_error,
            metadata=dict(obj.metadata_ or {}),
            created_at=obj.created_at,
            updated_at=obj.updated_at,
        )

    @staticmethod
    def _apply_domain(obj: ORMUserFile, user_file: UserFile) -> None:
        obj.user_id = user_file.user_id
        obj.storage_locator = user_file.storage_locator
        obj.original_filename = user_file.original_filename
        obj.normalized_extension = user_file.normalized_extension
        obj.declared_content_type = user_file.declared_content_type
        obj.detected_content_type = user_file.detected_content_type
        obj.declared_size_bytes = user_file.declared_size_bytes
        obj.stored_size_bytes = user_file.stored_size_bytes
        obj.sha256 = user_file.sha256
        obj.status = user_file.status
        if user_file.upload_expires_at is None:
            raise ValueError("User file upload expiry is required")
        obj.upload_expires_at = user_file.upload_expires_at
        obj.processed_at = user_file.processed_at
        obj.last_error = user_file.last_error
        obj.metadata_ = dict(user_file.metadata or {})

    async def create_user_file(self, user_file: UserFile) -> UserFile:
        obj = ORMUserFile(
            id=user_file.id,
            user_id=user_file.user_id,
            storage_locator=user_file.storage_locator,
            original_filename=user_file.original_filename,
            normalized_extension=user_file.normalized_extension,
            declared_content_type=user_file.declared_content_type,
            detected_content_type=user_file.detected_content_type,
            declared_size_bytes=user_file.declared_size_bytes,
            stored_size_bytes=user_file.stored_size_bytes,
            sha256=user_file.sha256,
            status=user_file.status,
            upload_expires_at=user_file.upload_expires_at,
            processed_at=user_file.processed_at,
            last_error=user_file.last_error,
            metadata_=dict(user_file.metadata or {}),
        )
        self._s.add(obj)
        await self._s.flush()
        await self._s.refresh(obj)
        return self._orm_to_domain(obj)

    async def get_user_file(
        self,
        *,
        user_id: str,
        file_id: str,
        include_deleted: bool = False,
    ) -> UserFile | None:
        stmt = select(ORMUserFile).where(ORMUserFile.id == file_id, ORMUserFile.user_id == user_id)
        if not include_deleted:
            stmt = stmt.where(ORMUserFile.status != STATUS_DELETED)
        result = await self._s.execute(stmt)
        obj = result.scalar_one_or_none()
        return self._orm_to_domain(obj) if obj is not None else None

    async def get_user_file_for_update(
        self,
        *,
        user_id: str,
        file_id: str,
        include_deleted: bool = False,
    ) -> UserFile | None:
        # ``populate_existing``: a row loaded earlier in this session must not answer
        # a locked read with the state it had before another request changed it.
        stmt = (
            select(ORMUserFile)
            .where(ORMUserFile.id == file_id, ORMUserFile.user_id == user_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if not include_deleted:
            stmt = stmt.where(ORMUserFile.status != STATUS_DELETED)
        result = await self._s.execute(stmt)
        obj = result.scalar_one_or_none()
        return self._orm_to_domain(obj) if obj is not None else None

    async def list_user_files(self, *, user_id: str) -> list[UserFile]:
        stmt = (
            select(ORMUserFile)
            .where(ORMUserFile.user_id == user_id, ORMUserFile.status != STATUS_DELETED)
            .order_by(desc(ORMUserFile.created_at))
        )
        result = await self._s.execute(stmt)
        return [self._orm_to_domain(obj) for obj in result.scalars()]

    async def update_user_file(self, user_file: UserFile) -> UserFile:
        obj = await self._s.get(ORMUserFile, user_file.id)
        if obj is None or obj.user_id != user_file.user_id:
            raise ValueError(f"user file not found: {user_file.id}")
        self._apply_domain(obj, user_file)
        await self._s.flush()
        await self._s.refresh(obj)
        return self._orm_to_domain(obj)


__all__ = ["SQLAlchemyUserFileRepository"]
