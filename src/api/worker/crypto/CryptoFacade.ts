import {
	assertNotNull,
	base64ToUint8Array,
	downcast,
	isSameTypeRef,
	neverNull,
	noOp,
	ofClass,
	stringToUtf8Uint8Array,
	TypeRef,
	uint8ArrayToBase64,
	uint8ArrayToHex,
} from "@tutao/tutanota-utils"
import { BucketPermissionType, GroupType, PermissionType } from "../../common/TutanotaConstants"
import { HttpMethod, resolveTypeReference } from "../../common/EntityFunctions"
import type { BucketKey, BucketPermission, GroupMembership, InstanceSessionKey, Permission } from "../../entities/sys/TypeRefs.js"
import {
	BucketKeyTypeRef,
	BucketPermissionTypeRef,
	createInstanceSessionKey,
	createPublicKeyData,
	createUpdatePermissionKeyData,
	GroupInfoTypeRef,
	GroupTypeRef,
	PermissionTypeRef,
	PushIdentifierTypeRef,
} from "../../entities/sys/TypeRefs.js"
import type { Contact, InternalRecipientKeyData } from "../../entities/tutanota/TypeRefs.js"
import {
	ContactTypeRef,
	createEncryptTutanotaPropertiesData,
	createInternalRecipientKeyData,
	TutanotaPropertiesTypeRef,
} from "../../entities/tutanota/TypeRefs.js"
import { typeRefToPath } from "../rest/EntityRestClient"
import { LockedError, NotFoundError, PayloadTooLargeError, TooManyRequestsError } from "../../common/error/RestError"
import { SessionKeyNotFoundError } from "../../common/error/SessionKeyNotFoundError" // importing with {} from CJS modules is not supported for dist-builds currently (must be a systemjs builder bug)
import { CryptoError } from "../../common/error/CryptoError"
import { birthdayToIsoDate, oldBirthdayToBirthday } from "../../common/utils/BirthdayUtils"
import type { Entity, SomeEntity, TypeModel } from "../../common/EntityTypes"
import { assertWorkerOrNode } from "../../common/Env"
import type { EntityClient } from "../../common/EntityClient"
import { RestClient } from "../rest/RestClient"
import {
	Aes128Key,
	aes128RandomKey,
	Aes256Key,
	aesEncrypt,
	bitArrayToUint8Array,
	decryptKey,
	decryptRsaKey,
	ENABLE_MAC,
	encryptKey,
	hexToPublicKey,
	IV_BYTE_LENGTH,
	random,
	sha256Hash,
	uint8ArrayToBitArray,
} from "@tutao/tutanota-crypto"
import { RecipientNotResolvedError } from "../../common/error/RecipientNotResolvedError"
import type { RsaImplementation } from "./RsaImplementation"
import { IServiceExecutor } from "../../common/ServiceRequest"
import { EncryptTutanotaPropertiesService } from "../../entities/tutanota/Services"
import { PublicKeyService, UpdatePermissionKeyService } from "../../entities/sys/Services"
import { UserFacade } from "../facades/UserFacade"
import { elementIdPart } from "../../common/utils/EntityUtils.js"
import { InstanceMapper } from "./InstanceMapper.js"
import { OwnerEncSessionKeysUpdateQueue } from "./OwnerEncSessionKeysUpdateQueue.js"

assertWorkerOrNode()

export function encryptBytes(sk: Aes128Key, value: Uint8Array): Uint8Array {
	return aesEncrypt(sk, value, random.generateRandomData(IV_BYTE_LENGTH), true, ENABLE_MAC)
}

export function encryptString(sk: Aes128Key, value: string): Uint8Array {
	return aesEncrypt(sk, stringToUtf8Uint8Array(value), random.generateRandomData(IV_BYTE_LENGTH), true, ENABLE_MAC)
}

export class CryptoFacade {
	constructor(
		private readonly userFacade: UserFacade,
		private readonly entityClient: EntityClient,
		private readonly restClient: RestClient,
		private readonly rsa: RsaImplementation,
		private readonly serviceExecutor: IServiceExecutor,
		private readonly instanceMapper: InstanceMapper,
		private readonly ownerEncSessionKeysUpdateQueue: OwnerEncSessionKeysUpdateQueue,
	) {}

	async applyMigrations<T>(typeRef: TypeRef<T>, data: any): Promise<T> {
		if (isSameTypeRef(typeRef, GroupInfoTypeRef) && data._ownerGroup == null) {
			let customerGroupMembership = this.userFacade.getLoggedInUser().memberships.find((g: GroupMembership) => g.groupType === GroupType.Customer) as any
			let customerGroupKey = this.userFacade.getGroupKey(customerGroupMembership.group)
			return this.entityClient.loadAll(PermissionTypeRef, data._id[0]).then((listPermissions: Permission[]) => {
				let customerGroupPermission = listPermissions.find((p) => p.group === customerGroupMembership.group)
				if (!customerGroupPermission) throw new SessionKeyNotFoundError("Permission not found, could not apply OwnerGroup migration")
				let listKey = decryptKey(customerGroupKey, (customerGroupPermission as any).symEncSessionKey)
				let groupInfoSk = decryptKey(listKey, base64ToUint8Array(data._listEncSessionKey))
				data._ownerGroup = customerGroupMembership.getGroup()
				data._ownerEncSessionKey = uint8ArrayToBase64(encryptKey(customerGroupKey, groupInfoSk))
				return data
			})
		} else if (isSameTypeRef(typeRef, TutanotaPropertiesTypeRef) && data._ownerEncSessionKey == null) {
			// EncryptTutanotaPropertiesService could be removed and replaced with an Migration that writes the key
			data._ownerGroup = this.userFacade.getUserGroupId()
			let groupEncSessionKey = encryptKey(this.userFacade.getUserGroupKey(), aes128RandomKey())
			data._ownerEncSessionKey = uint8ArrayToBase64(groupEncSessionKey)
			let migrationData = createEncryptTutanotaPropertiesData({
				properties: data._id,
				symEncSessionKey: groupEncSessionKey,
			})
			const result = await this.serviceExecutor.post(EncryptTutanotaPropertiesService, migrationData)
			return data
		} else if (isSameTypeRef(typeRef, PushIdentifierTypeRef) && data._ownerEncSessionKey == null) {
			// set sessionKey for allowing encryption when old instance (< v43) is updated
			return resolveTypeReference(typeRef)
				.then((typeModel) => this.updateOwnerEncSessionKey(typeModel, data, this.userFacade.getUserGroupKey(), aes128RandomKey()))
				.then(() => data)
		}

		return data
	}

	applyMigrationsForInstance<T>(decryptedInstance: T): Promise<T> {
		const instanceType = downcast<Entity>(decryptedInstance)._type

		if (isSameTypeRef(instanceType, ContactTypeRef)) {
			const contact: Contact = downcast(decryptedInstance)

			if (!contact.birthdayIso && contact.oldBirthdayAggregate) {
				contact.birthdayIso = birthdayToIsoDate(contact.oldBirthdayAggregate)
				contact.oldBirthdayAggregate = null
				contact.oldBirthdayDate = null
				return this.entityClient
					.update(contact)
					.catch(ofClass(LockedError, noOp))
					.then(() => decryptedInstance)
			} else if (!contact.birthdayIso && contact.oldBirthdayDate) {
				contact.birthdayIso = birthdayToIsoDate(oldBirthdayToBirthday(contact.oldBirthdayDate))
				contact.oldBirthdayDate = null
				return this.entityClient
					.update(contact)
					.catch(ofClass(LockedError, noOp))
					.then(() => decryptedInstance)
			} else if (contact.birthdayIso && (contact.oldBirthdayAggregate || contact.oldBirthdayDate)) {
				contact.oldBirthdayAggregate = null
				contact.oldBirthdayDate = null
				return this.entityClient
					.update(contact)
					.catch(ofClass(LockedError, noOp))
					.then(() => decryptedInstance)
			}
		}

		return Promise.resolve(decryptedInstance)
	}

	async resolveSessionKeyForInstance(instance: SomeEntity): Promise<Aes128Key | null> {
		const typeModel = await resolveTypeReference(instance._type)
		return this.resolveSessionKey(typeModel, instance)
	}

	/** Helper for the rare cases when we needed it on the client side. */
	async resolveSessionKeyForInstanceBinary(instance: SomeEntity): Promise<Uint8Array | null> {
		const key = await this.resolveSessionKeyForInstance(instance)
		return key == null ? null : bitArrayToUint8Array(key)
	}

	/** Resolve a session key an {@param instance} using an already known {@param ownerKey}. */
	resolveSessionKeyWithOwnerKey(instance: Record<string, any>, ownerKey: Aes128Key): Aes128Key {
		let key = instance._ownerEncSessionKey
		if (typeof key === "string") {
			key = base64ToUint8Array(instance._ownerEncSessionKey)
		}

		return decryptKey(ownerKey, key)
	}

	decryptSessionKey(instance: Record<string, any>, ownerEncSessionKey: Uint8Array): Aes128Key | Aes256Key {
		const gk = this.userFacade.getGroupKey(instance._ownerGroup)
		return decryptKey(gk, ownerEncSessionKey)
	}

	/**
	 * Returns the session key for the provided type/instance:
	 * * null, if the instance is unencrypted
	 * * the decrypted _ownerEncSessionKey, if it is available
	 * * the public decrypted session key, otherwise
	 *
	 * @param typeModel: the type model of the instance
	 * @param instance The unencrypted (client-side) instance or encrypted (server-side) object literal
	 */
	resolveSessionKey(typeModel: TypeModel, instance: Record<string, any>): Promise<Aes128Key | null> {
		return Promise.resolve()
			.then(async () => {
				if (!typeModel.encrypted) {
					return null
				}
				const elementId = this.getElementIdFromInstance(instance)
				if (instance.bucketKey) {
					// if we have a bucket key, then we need to cache the session keys stored in the bucket key for details, files, etc.
					// we need to do this BEFORE we check the owner enc session key
					const bucketKey = await this.convertBucketKeyToInstanceIfNecessary(instance.bucketKey)
					return this.resolveWithBucketKey(bucketKey, instance, typeModel)
				} else if (instance._ownerEncSessionKey && this.userFacade.isFullyLoggedIn() && this.userFacade.hasGroup(instance._ownerGroup)) {
					const gk = this.userFacade.getGroupKey(instance._ownerGroup)
					return this.resolveSessionKeyWithOwnerKey(instance, gk)
				} else if (instance.ownerEncSessionKey) {
					// TODO this is a service instance: Rename all ownerEncSessionKey attributes to _ownerEncSessionKey	 and add _ownerGroupId (set ownerEncSessionKey here automatically after resolving the group)
					// add to payment data service
					const gk = this.userFacade.getGroupKey(this.userFacade.getGroupId(GroupType.Mail))
					return this.resolveSessionKeyWithOwnerKey(instance, gk)
				} else {
					// See PermissionType jsdoc for more info on permissions
					const permissions = await this.entityClient.loadAll(PermissionTypeRef, instance._permissions)
					return this.trySymmetricPermission(permissions) ?? (await this.resolveWithPublicOrExternalPermission(permissions, instance, typeModel))
				}
			})
			.catch(
				ofClass(CryptoError, (e) => {
					console.log("failed to resolve session key", e)
					throw new SessionKeyNotFoundError("Crypto error while resolving session key for instance " + instance._id)
				}),
			)
	}

	/**
	 * In case the given bucketKey is a literal the literal will be converted to an instance and return. In case the BucketKey is already an instance the instance is returned.
	 * @param bucketKeyInstanceOrLiteral The bucket key as literal or instance
	 */
	async convertBucketKeyToInstanceIfNecessary(bucketKeyInstanceOrLiteral: Record<string, any>): Promise<BucketKey> {
		if (!this.isLiteralInstance(bucketKeyInstanceOrLiteral)) {
			// bucket key was already decoded from base 64
			return bucketKeyInstanceOrLiteral as BucketKey
		} else {
			// decryptAndMapToInstance is misleading here, but we want to map the BucketKey aggregate and its session key from a literal to an instance
			// to have the encrypted keys in binary format and not as base 64. There is actually no decryption ongoing, just mapToInstance.
			const bucketKeyTypeModel = await resolveTypeReference(BucketKeyTypeRef)
			return (await this.instanceMapper.decryptAndMapToInstance(bucketKeyTypeModel, bucketKeyInstanceOrLiteral, null)) as BucketKey
		}
	}

	private isLiteralInstance(elementOrLiteral: Record<string, any>): boolean {
		return typeof elementOrLiteral._type === "undefined"
	}

	private isTuple(element: unknown): element is IdTuple {
		return element != null && Array.isArray(element)
	}

	private trySymmetricPermission(listPermissions: Permission[]) {
		const symmetricPermission: Permission | null =
			listPermissions.find(
				(p) =>
					(p.type === PermissionType.Public_Symmetric || p.type === PermissionType.Symmetric) &&
					p._ownerGroup &&
					this.userFacade.hasGroup(p._ownerGroup),
			) ?? null

		if (symmetricPermission) {
			const gk = this.userFacade.getGroupKey(assertNotNull(symmetricPermission._ownerGroup))
			return decryptKey(gk, assertNotNull(symmetricPermission._ownerEncSessionKey))
		}
	}

	private async resolveWithBucketKey(bucketKey: BucketKey, instance: Record<string, any>, typeModel: TypeModel): Promise<Aes128Key | Aes256Key> {
		const instanceElementId = this.getElementIdFromInstance(instance)
		const ownerGroupId = neverNull(instance._ownerGroup)
		let decBucketKey = await this.decryptBucketKey(bucketKey, ownerGroupId, typeModel.name)
		const { resolvedSessionKeyForInstance, instanceSessionKeys } = this.collectAllInstanceSessionKeys(bucketKey, decBucketKey, instanceElementId, instance)
		this.ownerEncSessionKeysUpdateQueue.updateInstanceSessionKeys(instanceSessionKeys)

		if (resolvedSessionKeyForInstance) {
			// for symmetrically encrypted instances _ownerEncSessionKey is sent from the server.
			// in this case it is not yet and we need to set it because the rest of the app expects it.
			instance._ownerEncSessionKey = uint8ArrayToBase64(encryptKey(this.userFacade.getGroupKey(instance._ownerGroup), resolvedSessionKeyForInstance))
			return resolvedSessionKeyForInstance
		} else {
			throw new SessionKeyNotFoundError("no session key for instance " + instance._id)
		}
	}

	public async decryptBucketKey(bucketKey: BucketKey, ownerGroupId: Id, typeName: string): Promise<Aes128Key | Aes256Key> {
		if (bucketKey.keyGroup && bucketKey.pubEncBucketKey) {
			// bucket key is encrypted with public key for internal recipient
			return await this.decryptBucketKeyWithKeyPairOfGroup(bucketKey.keyGroup, bucketKey.pubEncBucketKey)
		} else if (bucketKey.groupEncBucketKey) {
			// secure external recipient
			let keyGroup
			if (bucketKey.keyGroup) {
				// legacy code path for old external clients that used to encrypt bucket keys with user group keys.
				// should be dropped once all old external mailboxes are cleared
				keyGroup = bucketKey.keyGroup
			} else {
				// by default, we try to decrypt the bucket key with the ownerGroupKey
				keyGroup = ownerGroupId
			}
			return decryptKey(this.userFacade.getGroupKey(keyGroup), bucketKey.groupEncBucketKey)
		} else {
			throw new SessionKeyNotFoundError(`encrypted bucket key not set on instance ${typeName}`)
		}
	}

	/**
	 * Calculates the SHA-256 checksum of a string value as UTF-8 bytes and returns it as a base64-encoded string
	 */
	public async sha256(value: string): Promise<string> {
		return uint8ArrayToBase64(sha256Hash(stringToUtf8Uint8Array(value)))
	}

	/**
	 * Resolves the session key for the provided instance and collects all other instances'
	 * session keys in order to update them.
	 */
	private collectAllInstanceSessionKeys(
		bucketKey: BucketKey,
		decBucketKey: number[],
		instanceElementId: string,
		instance: Record<string, any>,
	): { resolvedSessionKeyForInstance: Aes128Key | undefined; instanceSessionKeys: InstanceSessionKey[] } {
		let resolvedSessionKeyForInstance: Aes128Key | undefined = undefined
		const instanceSessionKeys = bucketKey.bucketEncSessionKeys.map((instanceSessionKey) => {
			const decryptedSessionKey = decryptKey(decBucketKey, instanceSessionKey.symEncSessionKey)
			if (instanceElementId == instanceSessionKey.instanceId) {
				resolvedSessionKeyForInstance = decryptedSessionKey
			}
			const ownerEncSessionKey = encryptKey(this.userFacade.getGroupKey(instance._ownerGroup), decryptedSessionKey)
			const instanceSessionKeyWithOwnerEncSessionKey = createInstanceSessionKey(instanceSessionKey)
			instanceSessionKeyWithOwnerEncSessionKey.symEncSessionKey = ownerEncSessionKey
			return instanceSessionKeyWithOwnerEncSessionKey
		})
		return { resolvedSessionKeyForInstance, instanceSessionKeys }
	}

	private async resolveWithPublicOrExternalPermission(
		listPermissions: Permission[],
		instance: Record<string, any>,
		typeModel: TypeModel,
	): Promise<Aes128Key> {
		const pubOrExtPermission = listPermissions.find((p) => p.type === PermissionType.Public || p.type === PermissionType.External) ?? null

		if (pubOrExtPermission == null) {
			const typeName = `${typeModel.app}/${typeModel.name}`
			throw new SessionKeyNotFoundError(`could not find permission for instance of type ${typeName} with id ${this.getElementIdFromInstance(instance)}`)
		}

		const bucketPermissions = await this.entityClient.loadAll(BucketPermissionTypeRef, assertNotNull(pubOrExtPermission.bucket).bucketPermissions)
		const bucketPermission = bucketPermissions.find(
			(bp) => (bp.type === BucketPermissionType.Public || bp.type === BucketPermissionType.External) && pubOrExtPermission._ownerGroup === bp._ownerGroup,
		)

		// find the bucket permission with the same group as the permission and public type
		if (bucketPermission == null) {
			throw new SessionKeyNotFoundError("no corresponding bucket permission found")
		}

		if (bucketPermission.type === BucketPermissionType.External) {
			return this.decryptWithExternalBucket(bucketPermission, pubOrExtPermission, instance)
		} else {
			return await this.decryptWithPublicBucket(bucketPermission, instance, pubOrExtPermission, typeModel)
		}
	}

	private decryptWithExternalBucket(bucketPermission: BucketPermission, pubOrExtPermission: Permission, instance: Record<string, any>) {
		let bucketKey

		if (bucketPermission.ownerEncBucketKey != null) {
			bucketKey = decryptKey(this.userFacade.getGroupKey(neverNull(bucketPermission._ownerGroup)), bucketPermission.ownerEncBucketKey)
		} else if (bucketPermission.symEncBucketKey) {
			bucketKey = decryptKey(this.userFacade.getUserGroupKey(), bucketPermission.symEncBucketKey)
		} else {
			throw new SessionKeyNotFoundError(
				`BucketEncSessionKey is not defined for Permission ${pubOrExtPermission._id.toString()} (Instance: ${JSON.stringify(instance)})`,
			)
		}

		return decryptKey(bucketKey, neverNull(pubOrExtPermission.bucketEncSessionKey))
	}

	private async decryptBucketKeyWithKeyPairOfGroup(keyPairGroupId: Id, pubEncBucketKey: Uint8Array): Promise<Aes128Key> {
		const group = await this.entityClient.load(GroupTypeRef, keyPairGroupId)
		const keypair = group.keys[0]
		try {
			const privKey = decryptRsaKey(this.userFacade.getGroupKey(group._id), keypair.symEncPrivKey)
			const decryptedBytes = await this.rsa.decrypt(privKey, pubEncBucketKey)
			return uint8ArrayToBitArray(decryptedBytes)
		} catch (e) {
			console.log("failed to decrypt rsa key for group with id " + group._id)
			throw e
		}
	}

	private async decryptWithPublicBucket(
		bucketPermission: BucketPermission,
		instance: Record<string, any>,
		pubOrExtPermission: Permission,
		typeModel: TypeModel,
	): Promise<Aes128Key> {
		const pubEncBucketKey = bucketPermission.pubEncBucketKey
		if (pubEncBucketKey == null) {
			throw new SessionKeyNotFoundError(
				`PubEncBucketKey is not defined for BucketPermission ${bucketPermission._id.toString()} (Instance: ${JSON.stringify(instance)})`,
			)
		}
		const bucketEncSessionKey = pubOrExtPermission.bucketEncSessionKey
		if (bucketEncSessionKey == null) {
			throw new SessionKeyNotFoundError(
				`BucketEncSessionKey is not defined for Permission ${pubOrExtPermission._id.toString()} (Instance: ${JSON.stringify(instance)})`,
			)
		}

		const bucketKey = await this.decryptBucketKeyWithKeyPairOfGroup(bucketPermission.group, pubEncBucketKey)

		const sk = decryptKey(bucketKey, bucketEncSessionKey)

		if (bucketPermission._ownerGroup) {
			// is not defined for some old AccountingInfos
			let bucketPermissionOwnerGroupKey = this.userFacade.getGroupKey(neverNull(bucketPermission._ownerGroup))
			let bucketPermissionGroupKey = this.userFacade.getGroupKey(bucketPermission.group)
			await this.updateWithSymPermissionKey(
				typeModel,
				instance,
				pubOrExtPermission,
				bucketPermission,
				bucketPermissionOwnerGroupKey,
				bucketPermissionGroupKey,
				sk,
			).catch(
				ofClass(NotFoundError, () => {
					console.log("w> could not find instance to update permission")
				}),
			)
		}
		return sk
	}

	/**
	 * Returns the session key for the provided service response:
	 * * null, if the instance is unencrypted
	 * * the decrypted _ownerPublicEncSessionKey, if it is available
	 * @param typeModel
	 * @param instance The unencrypted (client-side) or encrypted (server-side) instance
	 *
	 */
	resolveServiceSessionKey(typeModel: TypeModel, instance: Record<string, any>): Promise<Aes128Key | null> {
		if (instance._ownerPublicEncSessionKey) {
			return this.entityClient.load(GroupTypeRef, instance._ownerGroup).then((group) => {
				let keypair = group.keys[0]
				let gk = this.userFacade.getGroupKey(instance._ownerGroup)
				let privKey

				try {
					privKey = decryptRsaKey(gk, keypair.symEncPrivKey)
				} catch (e) {
					console.log("failed to decrypt rsa key for group with id " + group._id)
					throw e
				}

				return this.rsa
					.decrypt(privKey, base64ToUint8Array(instance._ownerPublicEncSessionKey))
					.then((decryptedBytes) => uint8ArrayToBitArray(decryptedBytes))
			})
		}

		return Promise.resolve(null)
	}

	/**
	 * Creates a new _ownerEncSessionKey and assigns it to the provided entity
	 * the entity must already have an _ownerGroup
	 * @returns the generated key
	 */
	setNewOwnerEncSessionKey(model: TypeModel, entity: Record<string, any>, keyToEncryptSessionKey?: Aes128Key): Aes128Key | null {
		if (!entity._ownerGroup) {
			throw new Error(`no owner group set  ${JSON.stringify(entity)}`)
		}

		if (model.encrypted) {
			if (entity._ownerEncSessionKey) {
				throw new Error(`ownerEncSessionKey already set ${JSON.stringify(entity)}`)
			}

			const sessionKey = aes128RandomKey()
			const effectiveKeyToEncryptSessionKey = keyToEncryptSessionKey ?? this.userFacade.getGroupKey(entity._ownerGroup)
			entity._ownerEncSessionKey = encryptKey(effectiveKeyToEncryptSessionKey, sessionKey)
			return sessionKey
		} else {
			return null
		}
	}

	encryptBucketKeyForInternalRecipient(
		bucketKey: Aes128Key,
		recipientMailAddress: string,
		notFoundRecipients: Array<string>,
	): Promise<InternalRecipientKeyData | void> {
		let keyData = createPublicKeyData({
			mailAddress: recipientMailAddress,
		})
		return this.serviceExecutor
			.get(PublicKeyService, keyData)
			.then((publicKeyData) => {
				let publicKey = hexToPublicKey(uint8ArrayToHex(publicKeyData.pubKey))
				let uint8ArrayBucketKey = bitArrayToUint8Array(bucketKey)

				if (notFoundRecipients.length === 0) {
					return this.rsa.encrypt(publicKey, uint8ArrayBucketKey).then((encrypted) => {
						let data = createInternalRecipientKeyData({
							mailAddress: recipientMailAddress,
							pubEncBucketKey: encrypted,
							pubKeyVersion: publicKeyData.pubKeyVersion,
						})
						return data
					})
				}
			})
			.catch(
				ofClass(NotFoundError, (e) => {
					notFoundRecipients.push(recipientMailAddress)
				}),
			)
			.catch(
				ofClass(TooManyRequestsError, (e) => {
					throw new RecipientNotResolvedError("")
				}),
			)
	}

	/**
	 * Updates the given public permission with the given symmetric key for faster access if the client is the leader and otherwise does nothing.
	 * @param typeModel: the type model of the instance
	 * @param instance The unencrypted (client-side) or encrypted (server-side) instance
	 * @param permission The permission.
	 * @param bucketPermission The bucket permission.
	 * @param permissionOwnerGroupKey The symmetric group key for the owner group on the permission.
	 * @param permissionGroupKey The symmetric group key of the group in the permission.
	 * @param sessionKey The symmetric session key.
	 */
	private updateWithSymPermissionKey(
		typeModel: TypeModel,
		instance: Record<string, any>,
		permission: Permission,
		bucketPermission: BucketPermission,
		permissionOwnerGroupKey: Aes128Key,
		permissionGroupKey: Aes128Key,
		sessionKey: Aes128Key,
	): Promise<void> {
		if (!this.isLiteralInstance(instance) || !this.userFacade.isLeader()) {
			// do not update the session key in case of an unencrypted (client-side) instance
			// or in case we are not the leader client
			return Promise.resolve()
		}

		if (!instance._ownerEncSessionKey && permission._ownerGroup === instance._ownerGroup) {
			return this.updateOwnerEncSessionKey(typeModel, instance, permissionOwnerGroupKey, sessionKey)
		} else {
			// instances shared via permissions (e.g. body)
			let updateService = createUpdatePermissionKeyData({
				permission: permission._id,
				bucketPermission: bucketPermission._id,
				ownerEncSessionKey: encryptKey(permissionOwnerGroupKey, sessionKey),
				symEncSessionKey: encryptKey(permissionGroupKey, sessionKey), // legacy can be removed
			})
			return this.serviceExecutor.post(UpdatePermissionKeyService, updateService).then(noOp)
		}
	}

	private updateOwnerEncSessionKey(typeModel: TypeModel, instance: Record<string, any>, ownerGroupKey: Aes128Key, sessionKey: Aes128Key): Promise<void> {
		instance._ownerEncSessionKey = uint8ArrayToBase64(encryptKey(ownerGroupKey, sessionKey))
		// we have to call the rest client directly because instance is still the encrypted server-side version
		const path = typeRefToPath(new TypeRef(typeModel.app, typeModel.name)) + "/" + (instance._id instanceof Array ? instance._id.join("/") : instance._id)
		const headers = this.userFacade.createAuthHeaders()
		headers.v = typeModel.version
		return this.restClient
			.request(path, HttpMethod.PUT, {
				headers,
				body: JSON.stringify(instance),
				queryParams: { updateOwnerEncSessionKey: "true" },
			})
			.catch(
				ofClass(PayloadTooLargeError, (e) => {
					console.log("Could not update owner enc session key - PayloadTooLargeError", e)
				}),
			)
	}

	private getElementIdFromInstance(instance: Record<string, any>): Id {
		if (typeof instance._id === "string") {
			return instance._id
		} else {
			const idTuple = instance._id as IdTuple
			return elementIdPart(idTuple)
		}
	}
}

if (!("toJSON" in Error.prototype)) {
	Object.defineProperty(Error.prototype as any, "toJSON", {
		value: function () {
			const alt: Record<string, any> = {}
			for (let key of Object.getOwnPropertyNames(this)) {
				alt[key] = this[key]
			}
			return alt
		},
		configurable: true,
		writable: true,
	})
}
