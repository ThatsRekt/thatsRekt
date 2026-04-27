import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, Relation as Relation_, IntColumn as IntColumn_} from "@subsquid/typeorm-store"
import {Post} from "./post.model"
import {Address} from "./address.model"

@Entity_()
export class PostVictim {
    constructor(props?: Partial<PostVictim>) {
        Object.assign(this, props)
    }

    /**
     * postId-address
     */
    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => Post, {nullable: true})
    post!: Relation_<Post>

    @Index_()
    @ManyToOne_(() => Address, {nullable: true})
    address!: Relation_<Address>

    /**
     * block at which this link was created (PostCreated or VictimsAdded)
     */
    @IntColumn_({nullable: false})
    createdAtBlock!: number
}
